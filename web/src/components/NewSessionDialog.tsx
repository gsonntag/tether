import { useEffect, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { modelLabel } from "../../../shared/labels";
import { HARNESS_LABELS, type HarnessId } from "../../../shared/transcript";
import { rpc } from "../connection";
import { openSession } from "../route";
import { folderName } from "../sessionList";
import { loadModels, loadProjects, modelListKey, useStore } from "../store";
import { focusComposerOf, openTerminalOf } from "./SessionView";

const MODE_KEY = "tether.newSessionMode";
const HARNESS_KEY = "tether.newSessionHarness";
const modeKey = (h: HarnessId) => (h === "claude" ? MODE_KEY : `${MODE_KEY}.${h}`);
const stored = (key: string) => {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};
const lastMode = (h: HarnessId) => stored(modeKey(h)) ?? (h === "codex" ? "untrusted" : "default");
const NO_PROJECTS: never[] = [];
const FALLBACK_MODES: { id: string; label: string; description?: string }[] = [
  { id: "default", label: "Ask first" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan" },
  { id: "bypassPermissions", label: "Bypass permissions" },
];

/** New session: pick a folder (or type one), a model and a permission mode; it opens ready to type. */
export function NewSessionDialog() {
  const open = useStore((s) => s.newSessionOpen);
  const runners = useStore((s) => s.runners);
  const online = runners.filter((r) => r.online);
  const [runnerId, setRunnerId] = useState<string>();
  const rid = runnerId && online.some((r) => r.id === runnerId) ? runnerId : online[0]?.id;
  const projects = useStore((s) => (rid ? (s.projects[rid] ?? NO_PROJECTS) : NO_PROJECTS));
  // The harnesses this runner drives (Claude Code first); a choice only when there are several.
  const offered = (online.find((r) => r.id === rid)?.harnesses ?? []).map((h) => h.id).filter((h): h is HarnessId => h in HARNESS_LABELS);
  const harnesses: HarnessId[] = offered.length ? (["claude", "codex"] as HarnessId[]).filter((h) => offered.includes(h)) : ["claude"];
  const [picked, setPicked] = useState<HarnessId>(() => (stored(HARNESS_KEY) as HarnessId) ?? "claude");
  const harness: HarnessId = harnesses.includes(picked) ? picked : harnesses[0]!;
  const models = useStore((s) => (rid ? s.modelLists[modelListKey(rid, harness)] : undefined));
  const [path, setPath] = useState("");
  const [model, setModel] = useState("default");
  const [modes_, setModes] = useState<Partial<Record<HarnessId, string>>>({});
  const mode = modes_[harness] ?? lastMode(harness);
  const setMode = (m: string) => setModes((x) => ({ ...x, [harness]: m }));
  /** start in the harness's own TUI instead of through Tether (SPEC §8) */
  const [inTerminal, setInTerminal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !rid) return;
    setError(undefined);
    void loadProjects(rid);
    if (!models) void loadModels(rid, harness);
  }, [open, rid, harness]);

  const shown = useMemo(() => {
    const q = path.trim().toLowerCase();
    const list = q ? projects.filter((p) => p.path.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : projects;
    return list.slice(0, 50);
  }, [projects, path]);

  const close = () => useStore.setState({ newSessionOpen: false });
  const create = async () => {
    if (!rid || !path.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { sessionId } = await rpc(rid, "newSession", { harness, projectPath: path.trim(), ...(modelOk && model !== "default" ? { model } : {}), permissionMode: validMode, ...(inTerminal ? { terminal: true } : {}) });
      try {
        localStorage.setItem(modeKey(harness), validMode);
        localStorage.setItem(HARNESS_KEY, harness);
      } catch {}
      close();
      setPath("");
      if (inTerminal) openTerminalOf(rid, sessionId);
      else focusComposerOf(rid, sessionId);
      openSession(rid, sessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const modes = models?.permissionModes.length ? models.permissionModes : harness === "claude" ? FALLBACK_MODES : [];
  // A mode another harness (or an older list) had: this one's first instead.
  const validMode = modes.some((m) => m.id === mode) ? mode : (modes[0]?.id ?? mode);
  const modelOk = !models || models.models.some((m) => m.id === model);
  return (
    <Dialog isOpen={open} onOpenChange={(o) => !o && close()} width={520} purpose="form">
      <DialogHeader title="New session" subtitle={HARNESS_LABELS[harness]} onOpenChange={(o) => !o && close()} />
      <div className="t-form" style={{ padding: 16 }}>
        {online.length > 1 && (
          <label>
            <span className="t-field-label">Runner</span>
            <select className="t-select" value={rid} onChange={(e) => setRunnerId(e.target.value)}>
              {online.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name || r.id}
                </option>
              ))}
            </select>
          </label>
        )}
        {harnesses.length > 1 && (
          <div className="t-seg" role="radiogroup" aria-label="Agent">
            {harnesses.map((h) => (
              <button
                type="button"
                role="radio"
                aria-checked={h === harness}
                key={h}
                className={`t-seg-opt${h === harness ? " on" : ""}`}
                onClick={() => {
                  setPicked(h);
                  setModel("default");
                }}
              >
                {HARNESS_LABELS[h]}
              </button>
            ))}
          </div>
        )}
        <div>
          <label className="t-field-label" htmlFor="t-new-path">
            Folder
          </label>
          <input
            id="t-new-path"
            className="t-search"
            placeholder="Pick below or type a path, e.g. ~/code/app"
            value={path}
            autoComplete="off"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
        </div>
        {shown.length > 0 && (
          <div className="t-projects" role="listbox" aria-label="Projects">
            {shown.map((p) => (
              <button type="button" role="option" aria-selected={p.path === path} key={p.path} className="t-proj-opt" onClick={() => setPath(p.path)}>
                <span>{p.name || folderName(p.path)}</span>
                <span className="t-path">{p.path}</span>
              </button>
            ))}
          </div>
        )}
        <label>
          <span className="t-field-label">Model</span>
          <select className="t-select" value={modelOk ? model : "default"} onChange={(e) => setModel(e.target.value)}>
            {(models?.models.length ? models.models : [{ id: "default", label: "Default" }]).map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === "default" ? modelLabel("default", models?.models) : m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="t-field-label">Permissions</span>
          <select className="t-select" value={validMode} onChange={(e) => setMode(e.target.value)}>
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {modes.find((m) => m.id === validMode)?.description && <span className="t-inline-status">{modes.find((m) => m.id === validMode)!.description}</span>}
        <label className="t-check">
          <input type="checkbox" checked={inTerminal} onChange={(e) => setInTerminal(e.target.checked)} />
          <span>Start in the terminal ({HARNESS_LABELS[harness]}'s own interface)</span>
        </label>
        {error && <div className="t-form-error">{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button label="Cancel" variant="secondary" onClick={close} />
          <Button label={busy ? "Starting…" : "Create"} variant="primary" isDisabled={!rid || !path.trim() || busy} onClick={() => void create()} />
        </div>
      </div>
    </Dialog>
  );
}
