import io
from email.message import Message
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from job_guard import GuardedJob, JobStopped
from manage import Guard, checked


class JobGuardTest(unittest.TestCase):
    def job(self, **options):
        job = GuardedJob("https://test.openai.azure.com", "fake", "gpt-6.2-sol",
                         **{"max_tokens": 100, "max_turns": 3, **options})
        job.opener = Mock()
        return job

    def respond(self, job, text, input_tokens=10, output_tokens=10):
        return job.respond(text, input_token_bound=input_tokens, max_output_tokens=output_tokens)

    def usage(self, input_tokens=2, output_tokens=3):
        return io.BytesIO(json.dumps({"usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}}).encode())

    def test_reserves_before_sending_and_reconciles_response_usage(self):
        job = self.job(max_tokens=25)
        job.opener.open.side_effect = [self.usage(), self.usage()]
        self.respond(job, "first")
        self.respond(job, "second")
        with self.assertRaisesRegex(JobStopped, "token budget"):
            self.respond(job, "third")
        self.assertEqual(job.tokens, 10)
        self.assertEqual(job.opener.open.call_count, 2)

    def test_dollar_and_turn_limits_reject_before_network(self):
        job = self.job(max_usd="0.0001", input_usd_per_million=10, output_usd_per_million=15)
        with self.assertRaisesRegex(JobStopped, "dollar budget"):
            self.respond(job, "expensive")
        job.opener.open.assert_not_called()
        job = self.job(max_turns=1)
        job.opener.open.return_value = self.usage()
        self.respond(job, "first")
        with self.assertRaisesRegex(JobStopped, "turn limit"):
            self.respond(job, "second")

    def test_identical_request_is_detected_across_intervening_turns(self):
        job = self.job(max_repeats=1)
        job.opener.open.side_effect = [self.usage(), self.usage()]
        self.respond(job, "first")
        self.respond(job, "second")
        with self.assertRaisesRegex(JobStopped, "identical"):
            self.respond(job, "first")

    @patch("job_guard.random.uniform", return_value=0)
    @patch("job_guard.time.sleep")
    def test_rate_limit_honors_retry_after_and_does_not_reserve_twice(self, sleep, _random):
        job = self.job()
        headers = Message()
        headers["retry-after-ms"] = "1500"
        job.opener.open.side_effect = [HTTPError(job.url, 429, "fake", headers, None), self.usage()]
        self.respond(job, "retry")
        sleep.assert_called_once_with(1.5)
        self.assertEqual((job.tokens, job.turns), (5, 1))

    def test_unknown_outcome_keeps_reservation_and_stops(self):
        job = self.job()
        job.opener.open.side_effect = TimeoutError()
        with self.assertRaisesRegex(JobStopped, "unavailable"):
            self.respond(job, "timeout")
        with self.assertRaises(JobStopped):
            self.respond(job, "new request")
        self.assertEqual((job.tokens, job.turns, job.opener.open.call_count), (20, 1, 1))

    def test_inaccurate_input_bound_stops_after_charging_actual_usage(self):
        job = self.job()
        job.opener.open.return_value = self.usage(11, 3)
        with self.assertRaisesRegex(JobStopped, "exceeded the reservation"):
            self.respond(job, "underestimated")
        self.assertEqual(job.tokens, 14)


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.arm = Mock()
        path = Path(__file__).with_name("config.example.json")
        self.guard = Guard(self.arm, checked(json.loads(path.read_text())))

    def test_install_scopes_permissions_and_alerts_to_the_named_deployments(self):
        def call(method, path, version, body=None, optional=False):
            if optional:
                return None
            if path == self.guard.resource:
                return {"location": "westus", "kind": "OpenAI"}
            if method == "GET" and "/deployments/" in path:
                return {"sku": {"name": "GlobalStandard", "capacity": 7000},
                        "properties": {"model": {"name": path.rsplit("/", 1)[1]}}}
            if method == "GET" and path == self.guard.automation:
                return {"identity": {"principalId": "identity"}}
            if path.endswith("generateUri"):
                return "https://webhook.example/?token=fake"
        self.arm.call.side_effect = call
        self.guard.install()
        writes = [args for args, _ in self.arm.call.call_args_list if args[0] == "PUT"]
        rules = [args[3] for args in writes if "/metricAlerts/" in args[1]]
        self.assertEqual(len(rules), 4)
        for rule in rules:
            props = rule["properties"]
            self.assertEqual((props["evaluationFrequency"], props["windowSize"]), ("PT1M", "PT5M"))
            self.assertEqual(props["scopes"], [self.guard.resource])
            dimension = props["criteria"]["allOf"][0]["dimensions"][0]
            self.assertIn(dimension["values"][0], self.guard.deployments)
        scopes = [args[1].split("/providers/Microsoft.Authorization/roleAssignments/")[0]
                  for args in writes if "/roleAssignments/" in args[1]]
        deployment_ids = [item["id"] for item in self.guard.deployments.values()]
        self.assertCountEqual(scopes, [self.guard.container, *deployment_ids])
        self.assertFalse(any(args[1] in deployment_ids for args in writes))

    def test_boost_schedules_both_reverts_before_starting_job(self):
        def call(method, path, version, body=None, optional=False):
            if method == "GET" and path == self.guard.group:
                receiver = {"name": "AzureOpenAISpendGuard", "webhookResourceId": "/hook"}
                return {"properties": {"enabled": True, "automationRunbookReceivers": [receiver]}}
            if method == "GET" and path == "/hook":
                return {"properties": {"isEnabled": True, "expiryTime": "2099-01-01T00:00:00Z"}}
            if method == "GET":
                return {"properties": {"enabled": True, "actions": [{"actionGroupId": self.guard.group}]}}
        self.arm.call.side_effect = call
        with patch.object(self.guard, "job") as run:
            run.side_effect = lambda *args, **kwargs: self.assertEqual(
                sum("/jobSchedules/" in call.args[1] for call in self.arm.call.call_args_list), 2
            )
            self.guard.boost("gpt-6.2-sol", 2000, 30)
            self.assertEqual(run.call_args.args, ("Boost", "gpt-6.2-sol"))


if __name__ == "__main__":
    unittest.main()
