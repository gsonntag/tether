import { isApiBilling } from "../../../shared/labels";
import type { BillingSource, SourceChoices, SourceOption } from "../../../shared/credentials";

/** What a session will draw from: a choice when there are several, in the API colour on a key. */
export function SourcePicker({ choices, value, onChange }: { choices?: SourceChoices; value?: BillingSource; onChange: (source: BillingSource) => void }) {
  const options = choices?.options ?? [];
  const picked = options.find((o) => o.source === value) ?? options[0];
  if (!picked) return null;
  const api = isApiBilling(picked.billing);
  if (options.length === 1) {
    return (
      <div>
        <span className="t-field-label">Source</span>
        <div>{api ? <span className="t-move-api">{picked.billing.label}</span> : picked.billing.label}</div>
      </div>
    );
  }
  return (
    <label>
      <span className="t-field-label">Source</span>
      <select aria-label="Source" className={`t-select${api ? " t-source-api" : ""}`} value={picked.source} onChange={(e) => onChange(e.target.value as BillingSource)}>
        {options.map((o) => (
          <option key={o.source} value={o.source}>
            {o.billing.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Azure's deployments, the models on that source; a runner from before lists has one. */
export const azureDeployments = (option?: SourceOption): { name: string; model?: string }[] | undefined =>
  option?.deployments?.length ? option.deployments : option?.deployment ? [{ name: option.deployment }] : undefined;

/** On Azure, the Model is one of its deployments, each shown with the model it runs. */
export function DeploymentPicker({ deployments, value, onChange }: { deployments: { name: string; model?: string }[]; value?: string; onChange: (name: string) => void }) {
  return (
    <label>
      <span className="t-field-label">Model</span>
      <select className="t-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {deployments.map((d) => (
          <option key={d.name} value={d.name}>
            {d.model && d.model !== d.name ? `${d.name} · ${d.model}` : d.name}
          </option>
        ))}
      </select>
    </label>
  );
}
