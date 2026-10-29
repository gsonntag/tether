import { useEffect, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { modelLabel } from "../../../shared/labels";
import { rpc } from "../connection";
import { openSession } from "../route";
import { folderName } from "../sessionList";
import { loadModels, loadProjects, modelListKey, useStore } from "../store";
import { focusComposerOf, openTerminalOf } from "./SessionView";

const MODE_KEY = "tether.newSessionMode";
const lastMode = () => {
  try {
    return localStorage.getItem(MODE_KEY) ?? "default";
  } catch {
    return "default";
  }
};
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
  const models = useStore((s) => (rid ? s.modelLists[modelListKey(rid, "claude")] : undefined));
  const [path, setPath] = useState("");
  const [model, setModel] = useState("default");
  const [mode, setMode] = useState(lastMode);
  /** start in Claude Code's own TUI instead of through Tether (SPEC §8) */
  const [inTerminal, setInTerminal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !rid) return;
    setError(undefined);
    void loadProjects(rid);
    if (!models) void loadModels(rid, "claude");
  }, [open, rid]);

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
      const { sessionId } = await rpc(rid, "newSession", { harness: "claude", projectPath: path.trim(), ...(model !== "default" ? { model } : {}), permissionMode: mode, ...(inTerminal ? { terminal: true } : {}) });
      try {
        localStorage.setItem(MODE_KEY, mode);
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

  const modes = models?.permissionModes.length ? models.permissionModes : FALLBACK_MODES;
  return (
    <Dialog isOpen={open} onOpenChange={(o) => !o && close()} width={520} purpose="form">
      <DialogHeader title="New session" subtitle="Claude Code" onOpenChange={(o) => !o && close()} />
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
          <select className="t-select" value={model} onChange={(e) => setModel(e.target.value)}>
            {(models?.models.length ? models.models : [{ id: "default", label: "Default" }]).map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === "default" ? modelLabel("default", models?.models) : m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="t-field-label">Permissions</span>
          <select className="t-select" value={mode} onChange={(e) => setMode(e.target.value)}>
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {modes.find((m) => m.id === mode)?.description && <span className="t-inline-status">{modes.find((m) => m.id === mode)!.description}</span>}
        <label className="t-check">
          <input type="checkbox" checked={inTerminal} onChange={(e) => setInTerminal(e.target.checked)} />
          <span>Start in the terminal (Claude Code's own interface)</span>
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
