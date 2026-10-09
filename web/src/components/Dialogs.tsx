import { useEffect, useState } from "react";
import { HARNESSES, NOTIFY_KINDS, type GuardMode, type HarnessId, type ModelProfile, type NotifyKind } from "../shared/protocol";
import { disablePush, enablePush, needsHomeScreen, pushState, pushSupported, testPush } from "../push";

const GUARD_HELP: Record<GuardMode, string> = {
  ask: "Safe actions run by themselves; anything else waits for you to approve it.",
  auto: "Safety rules plus a small judge model decide every action against your task. Never waits for you; blocked actions are explained to the agent and can be approved later.",
  full: "Everything is allowed. Only checkpoints (and Antigravity's sandbox) protect you.",
};
import { act, refreshProjects, rpc, selectSession, toggleProject, useStore } from "../store";
import { tildify } from "../util";
import { ChainEditor } from "./ChainEditor";
import { useModels } from "./ModelMenu";

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  const close = () => useStore.setState({ dialog: undefined });
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        {dialog === "new" && <NewSession close={close} />}
        {dialog === "addProject" && <AddProject close={close} />}
        {dialog === "settings" && <Settings close={close} />}
      </div>
    </div>
  );
}

function NewSession({ close }: { close: () => void }) {
  const allProjects = useStore((s) => s.projects);
  const projects = allProjects.filter((p) => !p.archived || p.path === initial);
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  const initial = useStore((s) => s.newSessionProject);
  const [project, setProject] = useState(initial ?? projects[0]?.path ?? "");
  const [harness, setHarness] = useState<HarnessId>(() => (localStorage.getItem("tether.harness") as HarnessId) || "claude-code");
  const [choice, setChoice] = useState(() => localStorage.getItem(`tether.model.${harness}`) ?? "");
  const [perm, setPerm] = useState(""); // "" = from the harness's own settings
  const [modes, setModes] = useState<string[]>([]);
  const [guard, setGuard] = useState<GuardMode>(() => (localStorage.getItem("tether.guard") as GuardMode) || "auto");
  const [prompt, setPrompt] = useState("");
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const models = useModels([harness]);
  useEffect(() => {
    setModes([]);
    rpc("listModels", { harness })
      .then((r) => setModes(r.permissionModes))
      .catch(() => {});
  }, [harness]);
  useEffect(() => {
    rpc("getProfiles", {}).then(setProfiles).catch(() => {});
  }, []);
  useEffect(() => setChoice(localStorage.getItem(`tether.model.${harness}`) ?? ""), [harness]);
  const available = HARNESSES.filter((h) => !runner || runner.harnesses.includes(h.id));

  const start = async () => {
    if (!project) return;
    setBusy(true);
    localStorage.setItem("tether.harness", harness);
    localStorage.setItem("tether.guard", guard);
    localStorage.setItem(`tether.model.${harness}`, choice);
    const isProfile = choice.startsWith("profile:");
    const s = await act("createSession", {
      projectPath: project,
      harness,
      model: !isProfile && choice ? choice : undefined,
      profile: isProfile ? choice.slice(8) : undefined,
      permissionMode: perm && modes.includes(perm) ? perm : undefined,
      guard,
      prompt: prompt.trim() || undefined,
    });
    setBusy(false);
    if (!s) return;
    close();
    toggleProject(project, true);
    selectSession(s.id);
  };

  return (
    <>
      <h3>New session</h3>
      <div className="field">
        <label>Project</label>
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name} — {tildify(p.path)}
            </option>
          ))}
        </select>
        <div className="hint">
          Not listed?{" "}
          <button className="link" style={{ color: "var(--acc)" }} onClick={() => useStore.setState({ dialog: "addProject" })}>
            Add a project
          </button>
        </div>
      </div>
      <div className="field">
        <label>Harness</label>
        <div className="seg">
          {available.map((h) => (
            <button key={h.id} className={harness === h.id ? "on" : ""} onClick={() => setHarness(h.id)}>
              {h.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Model or fallback profile</label>
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">{harness === "claude-code" || harness === "pi" ? "From your settings" : "Default"}</option>
          {profiles.length > 0 && (
            <optgroup label="Profiles (fallback chains)">
              {profiles.map((p) => (
                <option key={p.name} value={`profile:${p.name}`}>
                  {p.name}: {p.chain.join(" → ")}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Models">
            {(models[harness] ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.label && m.label !== m.id ? ` (${m.label})` : ""}
              </option>
            ))}
          </optgroup>
        </select>
        <div className="hint">A profile gives the session a fallback order across models and harnesses for usage limits. You can edit it per session later.</div>
      </div>
      <div className="field">
        <label>Approvals</label>
        <div className="seg">
          {(["ask", "auto", "full"] as GuardMode[]).map((g) => (
            <button key={g} className={guard === g ? "on" : ""} onClick={() => setGuard(g)}>
              {g === "ask" ? "Ask me" : g === "auto" ? "Auto (guarded)" : "Full access"}
            </button>
          ))}
        </div>
        <div className="hint">{GUARD_HELP[guard]} The project is checkpointed before every turn, so you can roll back.</div>
      </div>
      {modes.length > 0 && (
        <div className="field">
          <label>Mode</label>
          <div className="seg">
            <button className={perm === "" ? "on" : ""} onClick={() => setPerm("")}>
              from settings
            </button>
            {modes.map((m) => (
              <button key={m} className={perm === m ? "on" : ""} onClick={() => setPerm(m)}>
                {m}
              </button>
            ))}
          </div>
          <div className="hint">
            {harness === "antigravity"
              ? "Headless Antigravity can't ask for permission: in default mode, tools that need approval are skipped."
              : "For long unattended runs pick a mode that doesn't stop for every approval (e.g. acceptEdits or auto)."}
          </div>
        </div>
      )}
      <div className="field">
        <label>First message (optional)</label>
        <textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && start()}
          placeholder="What should the agent do?"
        />
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn pri" disabled={!project || busy} onClick={start}>
          {busy ? "Starting…" : "Start session"}
        </button>
      </div>
    </>
  );
}

function AddProject({ close }: { close: () => void }) {
  const [path, setPath] = useState("~");
  const [dirs, setDirs] = useState<string[]>([]);
  const [cwd, setCwd] = useState("");
  const browse = async (p: string) => {
    const r = await act("listDirs", { path: p });
    if (r) {
      setCwd(r.path);
      setPath(r.path);
      setDirs(r.dirs);
    }
  };
  useEffect(() => {
    browse("~");
  }, []);
  const add = async () => {
    const p = await act("addProject", { path });
    if (!p) return;
    await refreshProjects();
    toggleProject(p.path, true);
    useStore.setState({ dialog: "new", newSessionProject: p.path });
  };
  return (
    <>
      <h3>Add project</h3>
      <div className="field">
        <label>Directory on the runner</label>
        <input type="text" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && browse(path)} />
        <div className="dirs">
          {dirs.map((d) => (
            <button key={d} onClick={() => browse(d)}>
              {d === cwd.replace(/\/[^/]+\/?$/, "") || d.length < cwd.length ? "↑ .." : d.slice(cwd.length).replace(/^\//, "") + "/"}
            </button>
          ))}
        </div>
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn pri" onClick={add}>
          Add {tildify(path)}
        </button>
      </div>
    </>
  );
}

/** This device's push notifications from the selected runner. */
function NotificationSettings() {
  const [st, setSt] = useState<{ kinds?: NotifyKind[]; permission: NotificationPermission }>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (pushSupported()) pushState().then(setSt).catch((e) => setErr(e.message));
  }, []);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await f();
      setSt(await pushState());
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  const on = st?.kinds;
  const toggle = (k: NotifyKind) => on && run(() => enablePush(on.includes(k) ? on.filter((x) => x !== k) : [...on, k]));

  return (
    <>
      <h3>Notifications</h3>
      <div className="hint" style={{ marginBottom: 8 }}>
        The runner pushes them to this device when an agent has a question, finishes or gets blocked, even with Tether closed.
      </div>
      {!pushSupported() ? (
        <div className="hint">
          {needsHomeScreen() ? "On iPhone and iPad, add Tether to the Home Screen (Share → Add to Home Screen) and open it from there to get notifications." : "This browser can't receive push notifications."}
        </div>
      ) : !st ? (
        <div className="hint">{err ?? "Checking…"}</div>
      ) : (
        <>
          {on ? (
            <div className="field">
              <label>Notify this device about</label>
              <div className="seg">
                {NOTIFY_KINDS.map((k) => (
                  <button key={k.id} className={on.includes(k.id) ? "on" : ""} title={k.hint} disabled={busy} onClick={() => toggle(k.id)}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="btns" style={{ justifyContent: "flex-start" }}>
            {on ? (
              <>
                <button className="btn" disabled={busy} onClick={() => run(testPush)}>
                  Send a test
                </button>
                <button className="btn" disabled={busy} onClick={() => run(disablePush)}>
                  Turn off on this device
                </button>
              </>
            ) : (
              <button className="btn pri" disabled={busy} onClick={() => run(() => enablePush(NOTIFY_KINDS.map((k) => k.id)))}>
                Turn on for this device
              </button>
            )}
          </div>
          {st.permission === "denied" && <div className="hint">Notifications are blocked for this site; allow them in the browser's site settings.</div>}
          {err && <div className="err">{err}</div>}
        </>
      )}
    </>
  );
}

function Settings({ close }: { close: () => void }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [guard, setGuardInfo] = useState<{ antigravityHook: boolean; judgeModel: string; defaultMode: GuardMode }>();
  useEffect(() => {
    rpc("getProfiles", {}).then(setProfiles).catch(() => {});
    rpc("guardSetup", {}).then(setGuardInfo).catch(() => {});
  }, []);
  const updateGuard = async (args: { install?: boolean; judgeModel?: string; defaultMode?: GuardMode }) => {
    const r = await act("guardSetup", args);
    if (r) setGuardInfo(r);
  };
  const save = async () => {
    const r = await act("setProfiles", { profiles });
    if (r) {
      setProfiles(r);
      close();
    }
  };
  return (
    <>
      <NotificationSettings />
      <h3 style={{ marginTop: 18 }}>Guard</h3>
      {guard && (
        <>
          <div className="field">
            <label>Safety judge (decides what the rules don't cover, in Auto)</label>
            <div className="seg">
              {["haiku", "sonnet", "off"].map((m) => (
                <button key={m} className={guard.judgeModel === m ? "on" : ""} onClick={() => updateGuard({ judgeModel: m })}>
                  {m === "off" ? "Off (deny instead)" : `Claude ${m}`}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Default for new sessions</label>
            <div className="seg">
              {(["ask", "auto", "full"] as GuardMode[]).map((g) => (
                <button key={g} className={guard.defaultMode === g ? "on" : ""} onClick={() => updateGuard({ defaultMode: g })}>
                  {g}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Antigravity hook</label>
            {guard.antigravityHook ? (
              <div className="hint">Installed in ~/.gemini/config/hooks.json.</div>
            ) : (
              <>
                <div className="hint" style={{ marginBottom: 6 }}>
                  Antigravity only lets the guard see its tool calls through a PreToolUse hook. This adds a "tether-guard" entry to
                  ~/.gemini/config/hooks.json; it does nothing for Antigravity runs that Tether didn't start.
                </div>
                <button className="btn" onClick={() => updateGuard({ install: true })}>
                  Install hook
                </button>
              </>
            )}
          </div>
        </>
      )}
      <h3 style={{ marginTop: 18 }}>Fallback profiles</h3>
      <div className="hint" style={{ marginBottom: 12 }}>
        A profile is an ordered list of <span className="mono">harness:model</span> entries. When the current entry hits a usage limit
        the session moves down the list; a different harness gets the conversation handed off in the same directory. Rate limits retry on the same
        entry. Sessions copy the profile and can reorder their own copy.
      </div>
      {profiles.map((p, i) => (
        <div key={i} className="field" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <input
              type="text"
              value={p.name}
              placeholder="name"
              onChange={(e) => setProfiles(profiles.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <button className="btn danger" onClick={() => setProfiles(profiles.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
          <ChainEditor chain={p.chain} onChange={(c) => setProfiles(profiles.map((x, j) => (j === i ? { ...x, chain: c } : x)))} />
        </div>
      ))}
      <button className="btn" onClick={() => setProfiles([...profiles, { name: "", chain: [] }])}>
        ＋ Add profile
      </button>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn pri" onClick={save}>
          Save
        </button>
      </div>
    </>
  );
}
