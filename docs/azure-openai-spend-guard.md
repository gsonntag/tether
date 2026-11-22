# Azure OpenAI spend guard

Use a per-job budget for unattended work and Azure Monitor as a resource-wide backstop. Keep each deployment at the lowest capacity that accepts the largest request it needs to serve. Azure's monthly budget remains useful for credit and invoice tracking.

| Control | Why it is there |
| --- | --- |
| Budget each job before sending a request | A turn cap, token or dollar reservation, duplicate detection, and bounded 429 backoff stop the job locally. This also catches a slow loop that could stay under the Azure alert thresholds. |
| Alert on each deployment's prompt and output tokens | The metrics have one-minute granularity. Separate rules fire on either threshold, and the deployment dimension lets the other model continue serving. The action group emails the operator and invokes a runbook that lowers the affected deployment to its trip capacity. |
| Keep a lower baseline and time-box any raise | Lower capacity limits peak throughput independently of the alerts. The script creates the reversion schedule and a backup before requesting a raise. The runbook serializes changes with a per-deployment blob lease and records a trip until an operator rearms it. An old expiry job leaves a newer trip or boost alone. |

With the supplied Global Standard Sol estimates, 7M uncached prompt tokens per minute would be about $14/min at the short-context rate or $28/min at the long-context rate. Cache writes and generated tokens have different prices. These rates come from the supplied screenshot and are pending Microsoft confirmation. Tether uses its existing 272,000-input-token boundary for Sol estimates.

Cloud response time depends on metric ingestion, alert evaluation, runbook startup, and deployment update latency. The cloud guard reduces capacity for subsequent requests and may leave a small amount of throughput. Requests already accepted can finish. Metric thresholds measure throughput and do not enforce an exact dollar ceiling. Global Standard can process inference outside West US. The Automation account, Storage account, and action group are regional, and Azure requires metric alert rules to use the `global` control-plane location. [Azure OpenAI metrics](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-cognitiveservices-accounts-metrics) · [Azure OpenAI quotas](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/quotas-limits) · [Action group regions](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups)

## Install the Azure backstop

1. Copy the example configuration outside the repository. Set the target subscription, resource group, account, and notification email. Use a globally unique Storage account name. Confirm each deployment's name, model, and Global Standard capacity conversion in the Azure portal. The example assumes 1 SKU unit per 1,000 TPM, starts at 1,200 units per model to leave room for a roughly 1M-token request, and trips to 1 unit. Size baseline using prompt size plus the configured output maximum and check RPM as well as TPM.
2. Use Python 3.11 or newer and an Azure CLI identity with permission to manage the dedicated Automation, Storage, and Monitor resources, to create and assign custom roles, and to read the target deployments. Register `Microsoft.Automation`, `Microsoft.Storage`, and `Microsoft.Insights` if Azure reports that a provider is missing. The runbook's system identity receives deployment read/write only at the named deployment resources and blob read/write only in its own container. It uses its managed identity with the default Az.Accounts module in the PowerShell runtime. [Azure Automation managed identity](https://learn.microsoft.com/en-us/azure/automation/enable-managed-identity-for-automation)
3. Run the installer, check the job preview after role assignments propagate, then set baseline for each deployment during a quiet period. Install creates or updates the guard and starts alert evaluation as soon as the rules are enabled. A breached alert can lower a live deployment. Set the example thresholds against representative five-minute traffic before installing in a busy environment.

```bash
cp scripts/azure-spend-guard/config.example.json ~/azure-openai-spend-guard.json
# Fill in the copied configuration before installing.
az login
guard() {
  python3 scripts/azure-spend-guard/manage.py --config ~/azure-openai-spend-guard.json "$@"
}
guard install
guard status
guard preview gpt-6.2-sol
guard preview gpt-6-luna
guard rearm gpt-6.2-sol
guard rearm gpt-6-luna
```

The rules check five-minute totals every minute. Example thresholds are 2M prompt or 250K output tokens for Sol and 4M prompt or 500K output tokens for Luna. They are starting values. Use Azure Monitor's Metrics view split by deployment to tune them against normal bursts and supervised batch throughput. Sustained breaches may produce repeat emails and runbook jobs, so a transient runbook failure can get another attempt. Re-running `install` applies the configured thresholds and renews the webhook if it is within 14 days of expiry or its URL is unavailable to the installer. Schedule a reminder to reinstall before the roughly one-year webhook expiry. Treat the webhook URL as a credential. [Azure Automation webhook lifecycle](https://learn.microsoft.com/en-us/azure/automation/automation-webhooks)

## Guard unattended jobs

Keep one `GuardedJob` per synchronous text-only job. Call it at the request boundary, and stop the job when it raises `JobStopped`. Estimate the input bound from the full text and the deployed model's framing overhead, and set an explicit output bound. The dollar guard uses the supplied upper-bound rates for all input and output tokens. The example uses $10/M input for Sol, the largest Global Standard input-side rate in the supplied screenshot, and $15/M output. Use current rates from your Azure agreement when setting a production dollar budget.

```python
# Add scripts/azure-spend-guard to PYTHONPATH.
import os
from job_guard import GuardedJob

job = GuardedJob(
    os.environ["AZURE_OPENAI_ENDPOINT"],
    os.environ["AZURE_OPENAI_API_KEY"],
    "gpt-6.2-sol",
    max_tokens=2_000_000,
    max_turns=40,
    max_repeats=2,
    max_usd="20",
    input_usd_per_million="10",
    output_usd_per_million="15",
)
response = job.respond(
    "Reply with OK.",
    input_token_bound=256,
    max_output_tokens=64,
)
```

Use the same instance for every turn, including retries handled by the client. The in-memory budget lasts for that process. A resumable or distributed harness needs to persist and share its reservations before resuming or sending concurrent requests. Use the Azure backstop for other callers, including Tether/Codex. The example client supports text replies through the Responses API. A harness with streaming, images, tools, or hosted tool fees needs its own accounting for those operations.

## Test and recover

- Run `python3 -B -m unittest discover -s scripts/azure-spend-guard` for local budget, retry, and installer checks using mocked requests.
- Use `guard preview gpt-6.2-sol` to check Azure identity and resource access without changing capacity. Use `guard trip gpt-6.2-sol` during a quiet period to test the real capacity update with zero inference calls. Check `guard status` and the runbook job before rearming.
- To verify the alert, email, and runbook together, use a quiet deployment, set its prompt rule threshold to 1 in Azure Monitor, and send one small request with a small output cap. Check the fired alert, email, completed Automation job, and trip capacity. Restore the threshold by re-running `guard install`. Allow the five-minute test window to clear, then rearm.
- After a real trip, stop or pause the source workload and fix its retry or loop behavior. Check that the five-minute token signal has subsided, then run `guard rearm gpt-6.2-sol` or the corresponding Luna command. Verify the returned capacity with `guard status`. If the trip automation is unavailable, use the portal to lower the affected deployment's Tokens per Minute setting, then inspect the Automation job, role assignments, and webhook expiry.
- For a supervised job, run `guard boost gpt-6.2-sol --capacity 2000 --minutes 30` after setting baseline. Verify capacity at the end of the window and check the scheduled Automation job. If the revert job fails, a second scheduled job attempts the same revert ten minutes later. Use `guard trip gpt-6.2-sol` to end a boost early, then rearm when ready.
