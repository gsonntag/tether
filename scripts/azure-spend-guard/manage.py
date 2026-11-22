#!/usr/bin/env python3
"""Provision and operate the Azure OpenAI spend guard using an Azure CLI login."""

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import NAMESPACE_URL, uuid4, uuid5

ARM = "https://management.azure.com"
AUTOMATION = "2024-10-23"
COGNITIVE = "2024-10-01"
STORAGE = "2023-05-01"
RBAC = "2022-04-01"
GROUP = "2023-01-01"
ALERT = "2018-03-01"
RULES = {"prompt": "ProcessedPromptTokens", "output": "GeneratedTokens"}
RUNBOOK = "AzureOpenAISpendGuard"
TAG = {"managed-by": "azure-openai-spend-guard"}


def utc_now():
    return datetime.now(timezone.utc)


def timestamp(value):
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def stable_id(value):
    return str(uuid5(NAMESPACE_URL, value.lower()))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


class Arm:
    def __init__(self, subscription):
        result = subprocess.run(
            ["az", "account", "get-access-token", "--subscription", subscription,
             "--resource", ARM + "/", "--query", "accessToken", "-o", "tsv"],
            capture_output=True, text=True, check=False, timeout=60,
        )
        if result.returncode or not result.stdout.strip():
            raise RuntimeError("Azure CLI has no usable login for this subscription. Run az login.")
        self.token = result.stdout.strip()
        self.opener = build_opener(NoRedirect())

    def _request(self, method, url, body=None, optional=False):
        if urlsplit(url).netloc != "management.azure.com" or urlsplit(url).scheme != "https":
            raise RuntimeError("Unexpected Azure management URL")
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        data = None
        if isinstance(body, str):
            headers["Content-Type"] = "text/powershell"
            data = body.encode()
        elif body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        try:
            with self.opener.open(Request(url, data, headers, method=method), timeout=30) as response:
                raw = response.read()
                result = json.loads(raw) if raw and response.headers.get_content_type() == "application/json" else raw.decode() or None
                return response.status, response.headers, result
        except HTTPError as error:
            if optional and error.code == 404:
                return 404, {}, None
            # ARM errors can echo properties containing webhook credentials.
            raise RuntimeError(f"Azure returned HTTP {error.code} for {method} {urlsplit(url).path}") from None

    def call(self, method, path, version, body=None, optional=False):
        url = f"{ARM}{path}?api-version={version}"
        status, headers, result = self._request(method, url, body, optional)
        operation = headers.get("Azure-AsyncOperation") or headers.get("Location")
        if status == 202 and not operation:
            raise RuntimeError(f"Azure accepted {method} {path} without an operation status URL")
        if operation and status in (200, 201, 202) and method != "GET":
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                time.sleep(5)
                code, _, progress = self._request("GET", operation)
                state = (progress or {}).get("status") if isinstance(progress, dict) else None
                if code == 202 or state in ("Running", "InProgress", "Accepted"):
                    continue
                if state in ("Failed", "Canceled", "Cancelled"):
                    raise RuntimeError(f"Azure operation {state.lower()} for {path}")
                return result
            raise RuntimeError(f"Azure operation timed out for {path}")
        return result


def rule_name(account, deployment, signal):
    return f"{account}-{deployment}-{signal}-guard"


def metric_rule(account_id, deployment, signal, threshold, action_group):
    return {"location": "global", "tags": TAG, "properties": {
        "description": f"Throttle {deployment} after sustained Azure OpenAI {signal} token use.",
        "severity": 2,
        "enabled": True,
        "autoMitigate": False,
        "scopes": [account_id],
        "evaluationFrequency": "PT1M",
        "windowSize": "PT5M",
        "criteria": {"odata.type": "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria", "allOf": [{
            "name": signal,
            "criterionType": "StaticThresholdCriterion",
            "metricName": RULES[signal],
            "metricNamespace": "Microsoft.CognitiveServices/accounts",
            "operator": "GreaterThan",
            "timeAggregation": "Total",
            "threshold": threshold,
            "dimensions": [{"name": "ModelDeploymentName", "operator": "Include", "values": [deployment]}],
        }]},
        "actions": [{"actionGroupId": action_group}],
    }}


def checked(config):
    for key in ("resource_group", "account", "automation_account"):
        if not re.fullmatch(r"[\w.-]{1,64}", config[key], flags=re.ASCII):
            raise ValueError(f"Invalid {key}")
    if not re.fullmatch(r"[a-z0-9]{3,24}", config["storage_account"]):
        raise ValueError("Invalid storage_account")
    if not re.fullmatch(r"westus[23]?", config["automation_region"]):
        raise ValueError("Use a West US automation_region")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+", config["email"]):
        raise ValueError("Invalid email")
    if not config["deployments"]:
        raise ValueError("Set at least one deployment")
    for name, deployment in config["deployments"].items():
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", name):
            raise ValueError("Invalid deployment name")
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", deployment["model"]):
            raise ValueError("Invalid model name")
        for key in ("trip", "baseline", "maximum", *RULES):
            if type(deployment[key]) is not int or deployment[key] < 1:
                raise ValueError(f"{name} {key} must be a positive integer")
        if not deployment["trip"] < deployment["baseline"] <= deployment["maximum"]:
            raise ValueError(f"{name} requires trip < baseline <= maximum")
    return config


class Guard:
    def __init__(self, arm, config):
        self.arm = arm
        self.config = config
        self.subscription = f"/subscriptions/{config['subscription']}"
        self.rg = self.subscription + f"/resourceGroups/{config['resource_group']}"
        self.resource = self.rg + f"/providers/Microsoft.CognitiveServices/accounts/{config['account']}"
        self.automation = self.rg + f"/providers/Microsoft.Automation/automationAccounts/{config['automation_account']}"
        self.storage = self.rg + f"/providers/Microsoft.Storage/storageAccounts/{config['storage_account']}"
        self.container = self.storage + "/blobServices/default/containers/spend-guard"
        self.group = self.rg + f"/providers/Microsoft.Insights/actionGroups/{config['account']}-spend-guard"
        self.deployments = {}
        self.rules = {}
        for name, settings in config["deployments"].items():
            self.deployments[name] = {**settings, "id": self.resource + f"/deployments/{name}"}
            for signal in RULES:
                self.rules[rule_name(config["account"], name, signal)] = (name, signal)

    def owned(self, path, version):
        current = self.arm.call("GET", path, version, optional=True)
        if current and (current.get("tags") or {}).get("managed-by") != TAG["managed-by"]:
            raise RuntimeError(f"Refusing to overwrite an existing resource without the guard tag: {path}")
        return current

    def capacity(self, name):
        settings = self.deployments[name]
        current = self.arm.call("GET", settings["id"], COGNITIVE)
        if current["sku"]["name"] != "GlobalStandard" or current["properties"]["model"]["name"] != settings["model"]:
            raise RuntimeError(f"Unexpected model or SKU on {name}")
        return current["sku"]["capacity"]

    def grant(self, principal, label, actions, data_actions, scopes):
        role_id = self.subscription + "/providers/Microsoft.Authorization/roleDefinitions/" + stable_id(self.automation + label)
        self.arm.call("PUT", role_id, RBAC, {"properties": {
            "roleName": f"{self.config['automation_account']} - {label}",
            "description": "Scoped to this Azure OpenAI spend guard.",
            "type": "CustomRole",
            "assignableScopes": [self.rg],
            "permissions": [{"actions": actions, "dataActions": data_actions, "notActions": [], "notDataActions": []}],
        }})
        for scope in scopes:
            assignment_id = scope + "/providers/Microsoft.Authorization/roleAssignments/" + stable_id(scope + role_id + principal)
            self.arm.call("PUT", assignment_id, RBAC, {"properties": {
                "roleDefinitionId": role_id, "principalId": principal, "principalType": "ServicePrincipal",
            }})

    def install(self):
        account = self.arm.call("GET", self.resource, COGNITIVE)
        if account["location"].lower() != "westus" or account["kind"].lower() not in ("openai", "aiservices"):
            raise RuntimeError("Expected an Azure OpenAI account in West US")
        for name in self.deployments:
            self.capacity(name)
        self.owned(self.automation, AUTOMATION)
        self.owned(self.storage, STORAGE)
        existing_group = self.owned(self.group, GROUP)
        for rule in self.rules:
            self.owned(self.rg + f"/providers/Microsoft.Insights/metricAlerts/{rule}", ALERT)

        region = self.config["automation_region"]
        self.arm.call("PUT", self.automation, AUTOMATION, {
            "location": region, "identity": {"type": "SystemAssigned"}, "tags": TAG,
            "properties": {"sku": {"name": "Basic"}, "publicNetworkAccess": True},
        })
        self.arm.call("PUT", self.storage, STORAGE, {
            "location": region, "kind": "StorageV2", "sku": {"name": "Standard_LRS"}, "tags": TAG,
            "properties": {"allowBlobPublicAccess": False, "allowSharedKeyAccess": False,
                           "supportsHttpsTrafficOnly": True, "minimumTlsVersion": "TLS1_2"},
        })
        self.arm.call("PUT", self.container, STORAGE, {"properties": {"publicAccess": "None"}})
        principal = self.arm.call("GET", self.automation, AUTOMATION)["identity"]["principalId"]
        deployment_action = "Microsoft.CognitiveServices/accounts/deployments/"
        self.grant(principal, "deployment capacity", [deployment_action + "read", deployment_action + "write"],
                   [], [settings["id"] for settings in self.deployments.values()])
        blob_action = "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/"
        self.grant(principal, "circuit state", [], [blob_action + "read", blob_action + "write"], [self.container])

        runbook_id = self.automation + f"/runbooks/{RUNBOOK}"
        self.arm.call("PUT", runbook_id, AUTOMATION, {"location": region, "properties": {
            "description": "Throttle and restore Azure OpenAI capacity under a per-deployment lease.",
            "logVerbose": False, "logProgress": False, "runbookType": "PowerShell",
        }})
        runtime_config = {
            "accountId": self.resource,
            "storageUrl": f"https://{self.config['storage_account']}.blob.core.windows.net/spend-guard",
            "deployments": self.deployments,
            "rules": {rule: value[0] for rule, value in self.rules.items()},
        }
        source = Path(__file__).with_name("runbook.ps1").read_text()
        self.arm.call("PUT", runbook_id + "/draft/content", AUTOMATION,
                      source.replace("__GUARD_CONFIG__", json.dumps(runtime_config)))
        self.arm.call("POST", runbook_id + "/publish", AUTOMATION)
        self.install_alerts(existing_group)

    def install_alerts(self, existing_group):
        receivers = (existing_group or {}).get("properties", {}).get("automationRunbookReceivers", [])
        receiver = next((item for item in receivers if item["name"] == RUNBOOK), None)
        if receiver:
            hook = self.arm.call("GET", receiver["webhookResourceId"], AUTOMATION, optional=True)
            expiry = (hook or {}).get("properties", {}).get("expiryTime")
            if (not expiry or datetime.fromisoformat(expiry) < utc_now() + timedelta(days=14)
                    or not hook["properties"]["isEnabled"] or not receiver.get("serviceUri")):
                receiver = None
        if not receiver:
            webhook_id = self.automation + f"/webhooks/guard-{uuid4().hex[:12]}"
            uri = self.arm.call("POST", self.automation + "/webhooks/generateUri", AUTOMATION)
            if not isinstance(uri, str) or not uri.startswith("https://") or not urlsplit(uri).query:
                raise RuntimeError("Automation did not return a webhook URL")
            self.arm.call("PUT", webhook_id, AUTOMATION, {"properties": {
                "expiryTime": timestamp(utc_now() + timedelta(days=364)),
                "isEnabled": True, "runbook": {"name": RUNBOOK}, "uri": uri,
            }})
            receiver = {
                "name": RUNBOOK, "automationAccountId": self.automation, "runbookName": RUNBOOK,
                "webhookResourceId": webhook_id, "serviceUri": uri,
                "isGlobalRunbook": False, "useCommonAlertSchema": True,
            }

        self.arm.call("PUT", self.group, GROUP, {
            "location": self.config["automation_region"], "tags": TAG, "properties": {
                "enabled": True, "groupShortName": "AOAISpend",
                "emailReceivers": [{"name": "Owner", "emailAddress": self.config["email"], "useCommonAlertSchema": True}],
                "automationRunbookReceivers": [receiver],
            },
        })
        for rule, (deployment, signal) in self.rules.items():
            path = self.rg + f"/providers/Microsoft.Insights/metricAlerts/{rule}"
            self.arm.call("PUT", path, ALERT,
                          metric_rule(self.resource, deployment, signal, self.deployments[deployment][signal], self.group))

    def job(self, mode, name, **parameters):
        path = self.automation + f"/jobs/{uuid4()}"
        self.arm.call("PUT", path, AUTOMATION, {"properties": {
            "runbook": {"name": RUNBOOK},
            "parameters": {"Mode": mode, "Deployment": name, **parameters},
        }})
        print(f"Automation job {path}", flush=True)
        deadline = time.monotonic() + 420
        while time.monotonic() < deadline:
            time.sleep(5)
            status = self.arm.call("GET", path, AUTOMATION)["properties"]["status"]
            if status == "Completed":
                print(f"{name} capacity is {self.capacity(name)} SKU units.")
                return
            if status in ("Failed", "Stopped", "Suspended"):
                raise RuntimeError(f"Automation job {status.lower()}. Inspect its output in Azure.")
        raise RuntimeError("Job is still pending. Check it in Azure before submitting another.")

    def boost(self, name, capacity, duration):
        settings = self.deployments[name]
        if not settings["baseline"] < capacity <= settings["maximum"] or not 10 <= duration <= 60:
            raise ValueError("Boost requires baseline < capacity <= maximum and 10 to 60 minutes")
        group = self.arm.call("GET", self.group, GROUP)["properties"]
        receiver = next(item for item in group["automationRunbookReceivers"] if item["name"] == RUNBOOK)
        hook = self.arm.call("GET", receiver["webhookResourceId"], AUTOMATION)["properties"]
        expires = utc_now() + timedelta(minutes=duration)
        if not group["enabled"] or not hook["isEnabled"] or datetime.fromisoformat(hook["expiryTime"]) <= expires:
            raise RuntimeError("Install an enabled action group and webhook before boosting capacity")
        for rule, (target, _) in self.rules.items():
            if target == name:
                path = self.rg + f"/providers/Microsoft.Insights/metricAlerts/{rule}"
                alert = self.arm.call("GET", path, ALERT)["properties"]
                if not alert["enabled"] or not any(action["actionGroupId"].lower() == self.group.lower()
                                                   for action in alert["actions"]):
                    raise RuntimeError(f"Repair {rule} before boosting capacity")

        boost_id = uuid4().hex
        for suffix, start in (("", expires), ("-retry", expires + timedelta(minutes=10))):
            schedule = "guard-expire-" + boost_id + suffix
            self.arm.call("PUT", self.automation + f"/schedules/{schedule}", AUTOMATION, {"properties": {
                "startTime": timestamp(start), "frequency": "OneTime", "timeZone": "UTC",
            }})
            self.arm.call("PUT", self.automation + f"/jobSchedules/{uuid4()}", AUTOMATION, {"properties": {
                "schedule": {"name": schedule}, "runbook": {"name": RUNBOOK},
                "parameters": {"Mode": "Expire", "Deployment": name, "BoostId": boost_id},
            }})
        print(f"Revert scheduled for {timestamp(expires)}, with a backup ten minutes later.", flush=True)
        self.job("Boost", name, BoostId=boost_id, Capacity=str(capacity), Until=timestamp(expires))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("install")
    commands.add_parser("status")
    for name in ("preview", "trip", "rearm", "boost"):
        command = commands.add_parser(name)
        command.add_argument("deployment")
        if name == "boost":
            command.add_argument("--capacity", type=int, required=True)
            command.add_argument("--minutes", type=int, required=True)
    args = parser.parse_args()
    try:
        config = checked(json.loads(args.config.read_text()))
        if not re.fullmatch(r"[a-fA-F0-9-]{36}", config["subscription"]):
            raise ValueError("Set a valid Azure subscription ID")
        guard = Guard(Arm(config["subscription"]), config)
        if args.command == "install":
            guard.install()
        elif args.command == "status":
            for name in guard.deployments:
                print(f"{name}: {guard.capacity(name)} SKU units")
        else:
            if args.deployment not in guard.deployments:
                raise ValueError("Deployment is missing from the configuration")
            if args.command == "boost":
                guard.boost(args.deployment, args.capacity, args.minutes)
            else:
                guard.job(args.command.capitalize(), args.deployment)
    except (KeyError, OSError, ValueError, RuntimeError, StopIteration, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
