import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { findModel, modelLabel, prettyModel } from "../../../shared/labels";
import { resolveSourceModel, type BillingSource, type SourceChoices } from "../../../shared/credentials";
import type { ActiveClone, FolderCheck } from "../../../shared/protocol";
import type { WorkspaceInfo } from "../../../shared/worktree";
import { CLAUDE_UNSET, HARNESS_LABELS, type HarnessId } from "../../../shared/transcript";
import { useAccountLabel } from "../accountLabel";
import { rpc } from "../connection";
import { CHECK_DELAY_MS, folderBlocked } from "../folderCheck";
import { openSession } from "../route";
import { folderName } from "../sessionList";
import { loadModels, loadProjects, modelListKey, useStore } from "../store";
import { AddProject } from "./AddProject";
import { focusComposerOf, openTerminalOf } from "./SessionView";
import { radioKeys } from "../radioKeys";
import { ago } from "../runners";
import { sourceModels, DeploymentPicker, SourcePicker } from "./SourcePicker";

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
const WORKSPACES = ["folder", "worktree"] as const;
type Workspace = (typeof WORKSPACES)[number];
const WORKSPACE_LABELS: Record<Workspace, string> = { folder: "This folder", worktree: "New worktree" };
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
  const runnerFilter = useStore((s) => s.runnerFilter);
  const online = runners.filter((r) => r.online);
  const [runnerId, setRunnerId] = useState<string>();
  const defaultRunnerId = (runnerFilter && online.some((r) => r.id === runnerFilter) ? runnerFilter : undefined) ?? online[0]?.id;
  const rid = runnerId && online.some((r) => r.id === runnerId) ? runnerId : defaultRunnerId;
  const projects = useStore((s) => (rid ? (s.projects[rid] ?? NO_PROJECTS) : NO_PROJECTS));
  // The harnesses this runner drives (Claude Code first); a choice only when there are several.
  const offered = (online.find((r) => r.id === rid)?.harnesses ?? []).map((h) => h.id).filter((h): h is HarnessId => h in HARNESS_LABELS);
  const harnesses: HarnessId[] = offered.length ? (["claude", "codex", "antigravity"] as HarnessId[]).filter((h) => offered.includes(h)) : ["claude"];
  const [picked, setPicked] = useState<HarnessId>(() => (stored(HARNESS_KEY) as HarnessId) ?? "claude");
  const harness: HarnessId = harnesses.includes(picked) ? picked : harnesses[0]!;
  const models = useStore((s) => (rid ? s.modelLists[modelListKey(rid, harness)] : undefined));
  const [path, setPath] = useState("");
  const typed = path.trim();
  /** what the runner says about `typed`; nothing until it answers, so nothing flashes while typing */
  const [check, setCheck] = useState<FolderCheck>();
  const [createFolder, setCreateFolder] = useState(false);
  const checkId = useRef(0);
  const [model, setModel] = useState("default");
  const [modes_, setModes] = useState<Partial<Record<HarnessId, string>>>({});
  const mode = modes_[harness] ?? lastMode(harness);
  const setMode = (m: string) => setModes((x) => ({ ...x, [harness]: m }));
  /** start in the harness's own TUI instead of through Tether (SPEC §8) */
  const [inTerminal, setInTerminal] = useState(false);
  /** Add project's panel, in place of the project list */
  const [adding, setAdding] = useState(false);
  /** a clone still running from before the dialog was closed: Add project opens on it */
  const [resume, setResume] = useState<ActiveClone>();
  /** whether the folder is in git, and what New worktree would make there (SPEC §4); nothing: not offered */
  const [ws, setWs] = useState<WorkspaceInfo>();
  /** the folder workspaceInfo last answered (or failed) for: until it's the one typed, a worktree choice can't be acted on */
  const [wsFor, setWsFor] = useState<string>();
  const [workspace, setWorkspace] = useState<Workspace>("folder");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  /** a create on its way: a second Enter (in any field) doesn't start another */
  const creating = useRef(false);
  const [error, setError] = useState<string>();
  /** what's there to bill to. Nothing from an older runner: no picker, and the runner decides */
  const [sources, setSources] = useState<SourceChoices>();
  const sourcesAsked = useRef<Promise<SourceChoices | undefined>>(undefined);
  const [source, setSource] = useState<BillingSource>();
  const { label: accountLabel } = useAccountLabel(rid, harness, open);
  // Antigravity has only its implicit subscription and no source switching.
  const pickerSources: SourceChoices | undefined = harness === "antigravity" && accountLabel && !sources?.options.length
    ? { options: [{ source: "subscription", billing: { kind: "plan", label: accountLabel } }] }
    : sources;

  useEffect(() => {
    if (!open) setRunnerId(undefined);
  }, [open]);

  useEffect(() => {
    if (!open || !rid) return;
    setError(undefined);
    setAdding(false);
    void loadProjects(rid);
    if (!models) void loadModels(rid, harness);
    setSources(undefined);
    setSource(undefined);
    const asked = rpc(rid, "billingSources", { harness }).catch(() => undefined);
    sourcesAsked.current = asked;
    void asked.then((s) => {
      if (sourcesAsked.current !== asked) return;
      setSources(s);
      setSource(s?.default);
    });
  }, [open, rid, harness]);

  useEffect(() => {
    setResume(undefined);
    if (!open || !rid) return;
    let gone = false;
    // A runner too old to say: nothing to pick up.
    void rpc(rid, "activeClones", {})
      .then(({ clones }) => {
        if (gone || !clones[0]) return;
        setResume(clones[0]);
        setAdding(true);
      })
      .catch(() => {});
    return () => void (gone = true);
  }, [open, rid]);

  const checkPath = async (id: number) => {
    const c = await rpc(rid!, "checkFolder", { projectPath: typed }).catch(() => undefined);
    if (id === checkId.current) setCheck(c);
    return c;
  };
  useEffect(() => {
    const id = ++checkId.current;
    setCheck(undefined);
    setCreateFolder(false);
    setError(undefined);
    if (!open || !rid || !typed) return;
    const t = setTimeout(() => void checkPath(id), CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, [open, rid, typed]);

  // An existing folder: is it in git? (A runner too old to say: no Workspace choice.)
  const existing = check?.state === "exists" ? check.path : undefined;
  useEffect(() => {
    setWs(undefined);
    setWsFor(undefined);
    if (!open || !rid || !existing) return;
    let gone = false;
    void rpc(rid, "workspaceInfo", { projectPath: existing })
      .then((w) => {
        if (gone) return;
        setWs(w);
        setWsFor(existing);
      })
      .catch(() => !gone && setWsFor(existing));
    return () => void (gone = true);
  }, [open, rid, existing]);
  // A worktree choice on a folder not looked at yet: Create would otherwise start in the folder itself.
  const wsPending = workspace !== "folder" && (!check || (check.state === "exists" && wsFor !== check.path));
  const inWorktree = workspace === "worktree" && !!ws?.git;
  // A repo's setup runs before the first message, which its own TUI wouldn't wait for (SPEC §4).
  const noTerminal = inWorktree && !!ws.setup;
  const terminal = inTerminal && !noTerminal;

  const shown = useMemo(() => {
    const q = path.trim().toLowerCase();
    const list = q ? projects.filter((p) => p.path.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : projects;
    return list.slice(0, 50);
  }, [projects, path]);

  const close = () => useStore.setState({ newSessionOpen: false });
  const create = async () => {
    if (!rid || !typed || busy || creating.current) return;
    creating.current = true;
    setBusy(true);
    setError(undefined);
    try {
      // Enter before the check came back: wait for it, so a missing folder still asks first.
      const checked = check ?? (await checkPath(checkId.current));
      if (folderBlocked(checked, createFolder)) return;
      if (workspace !== "folder" && checked?.state === "exists" && wsFor !== checked.path) return setError("Still looking at this folder. Try again in a moment.");
      // Enter before the sources came back: what's shown first is what starts.
      const billTo = source ?? (await sourcesAsked.current)?.default;
      const common = { harness, projectPath: typed, ...(billTo ? { source: billTo } : {}), ...(deployments ? { model: deployment } : modelOk && model !== "default" ? { model } : {}), permissionMode: validMode, ...(terminal ? { terminal: true } : {}) };
      // The branch shown is the branch made: the placeholder when nothing is typed.
      const { sessionId } = inWorktree
        ? await rpc(rid, "newWorktreeSession", { ...common, branch: branch.trim() || ws.branch, ...(ws.setupId !== undefined ? { expectSetup: ws.setupId } : {}) })
        : await rpc(rid, "newSession", { ...common, ...(check?.state === "missing" && createFolder ? { createFolder: true } : {}) });
      try {
        localStorage.setItem(modeKey(harness), validMode);
        localStorage.setItem(HARNESS_KEY, harness);
      } catch {}
      close();
      setPath("");
      setBranch("");
      setWorkspace("folder");
      if (terminal) openTerminalOf(rid, sessionId);
      else focusComposerOf(rid, sessionId);
      openSession(rid, sessionId);
    } catch (e) {
      setError((e as Error).message);
      // The setup (or the branch) changed meanwhile: show what's there now.
      if (inWorktree && rid && existing) void rpc(rid, "workspaceInfo", { projectPath: existing }).then(setWs).catch(() => {});
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };

  const modes = models?.permissionModes.length ? models.permissionModes : harness === "claude" ? FALLBACK_MODES : [];
  // A mode another harness (or an older list) had: this one's first instead.
  const validMode = modes.some((m) => m.id === mode) ? mode : (modes[0]?.id ?? mode);
  const modelOk = !models || models.models.some((m) => m.id === model);
  // Claude with nothing picked: what the runner starts it on, by that name.
  const listed = models?.models.length ? models.models : harness === "claude" ? [{ id: CLAUDE_UNSET.model, label: prettyModel(CLAUDE_UNSET.model) }] : [{ id: "default", label: "Default" }];
  const unpicked = harness === "claude" ? (findModel(listed, CLAUDE_UNSET.model)?.id ?? CLAUDE_UNSET.model) : "default";
  // Azure and Bedrock use the model list for the selected source.
  const deployments = sourceModels(sources?.options.find((o) => o.source === source));
  const deployment = deployments && ((source === "bedrock" ? resolveSourceModel(deployments, model) : deployments.find((d) => d.name === model)?.name) ?? deployments[0]?.name);
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
          <div
            className="t-seg"
            role="radiogroup"
            aria-label="Agent"
            onKeyDown={radioKeys(harnesses, harness, (h) => {
              setPicked(h);
              setModel("default");
            })}
          >
            {harnesses.map((h) => (
              <button
                type="button"
                role="radio"
                aria-checked={h === harness}
                tabIndex={h === harness ? 0 : -1}
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
          <div className="t-field-row">
            <label className="t-field-label" htmlFor="t-new-path">
              Folder
            </label>
            {rid && !adding && <Button label="Add project" variant="secondary" size="sm" onClick={() => setAdding(true)} />}
          </div>
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
        {check?.state === "missing" && (
          <div className="t-folder-missing">
            <span className="t-inline-status">This folder doesn't exist yet.</span>
            <label className="t-check">
              <input type="checkbox" checked={createFolder} onChange={(e) => setCreateFolder(e.target.checked)} />
              <span>Create folder</span>
            </label>
          </div>
        )}
        {check?.error && !(check.state === "relative" && shown.length > 0) && <div className="t-form-error">{check.error}</div>}
        {ws?.git && !adding && (
          <div className="t-workspace">
            <span className="t-field-label" id="t-new-ws">
              Workspace
            </span>
            <div className="t-seg" role="radiogroup" aria-labelledby="t-new-ws" onKeyDown={radioKeys(WORKSPACES, workspace, setWorkspace)}>
              {WORKSPACES.map((w) => (
                <button type="button" role="radio" aria-checked={workspace === w} tabIndex={workspace === w ? 0 : -1} key={w} className={`t-seg-opt${workspace === w ? " on" : ""}`} onClick={() => setWorkspace(w)}>
                  {WORKSPACE_LABELS[w]}
                </button>
              ))}
            </div>
            {inWorktree && (
              <>
                <label>
                  <span className="t-field-label">Branch</span>
                  <input className="t-search" placeholder={ws.branch} value={branch} autoComplete="off" spellCheck={false} onChange={(e) => setBranch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
                </label>
                <span className="t-ws-note">
                  A new folder beside the repo, from {ws.base}
                  {ws.remote ? `, fetched just before it's made (last fetched ${ws.fetchedAt ? ago(ws.fetchedAt) : "never"}; if the fetch fails, as last fetched)` : ""}.
                  {ws.setup && !ws.setupText && (
                    <>
                      {" "}
                      Runs <code>{ws.setup}</code> there first; your first message waits for it.
                    </>
                  )}
                </span>
                {ws.setupText && (
                  <details className="t-ws-setup">
                    <summary>Runs .tether/setup there first; your first message waits for it</summary>
                    <pre className="t-pre">
                      {ws.setupText}
                      {ws.setupTextCut ? "\n… (cut here: only the start is shown)" : ""}
                    </pre>
                  </details>
                )}
              </>
            )}
          </div>
        )}
        {adding && rid && (
          <AddProject
            key={resume?.cloneId ?? "new"}
            runnerId={rid}
            resume={resume}
            onCancel={() => {
              setAdding(false);
              setResume(undefined);
            }}
            onPick={(p) => {
              setPath(p);
              setAdding(false);
              setResume(undefined);
            }}
          />
        )}
        {!adding && shown.length > 0 && (
          <div className="t-projects" role="listbox" aria-label="Projects">
            {shown.map((p) => (
              <button type="button" role="option" aria-selected={p.path === path} key={p.path} className="t-proj-opt" onClick={() => setPath(p.path)}>
                <span>{p.name || folderName(p.path)}</span>
                <span className="t-path">{p.path}</span>
              </button>
            ))}
          </div>
        )}
        <SourcePicker accountLabel={accountLabel} choices={pickerSources} value={source} onChange={setSource} />
        {deployments ? (
          <DeploymentPicker deployments={deployments} value={deployment} onChange={setModel} />
        ) : (
          <label>
            <span className="t-field-label">Model</span>
            <select className="t-select" value={modelOk && model !== "default" ? model : unpicked} onChange={(e) => setModel(e.target.value)}>
              {listed.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === "default" ? modelLabel("default", models?.models) : m.label}
                </option>
              ))}
            </select>
          </label>
        )}
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
          <input type="checkbox" checked={terminal} disabled={noTerminal} onChange={(e) => setInTerminal(e.target.checked)} />
          <span>Start in the terminal ({HARNESS_LABELS[harness]}'s own interface)</span>
        </label>
        {noTerminal && inTerminal && <span className="t-inline-status">Not with this worktree: its setup runs first, and the terminal wouldn't wait for it.</span>}
        {error && <div className="t-form-error" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button label="Cancel" variant="secondary" onClick={close} />
          <Button label={busy ? "Starting…" : "Create"} variant="primary" isDisabled={!rid || !typed || busy || folderBlocked(check, createFolder) || wsPending} onClick={() => void create()} />
        </div>
      </div>
    </Dialog>
  );
}
