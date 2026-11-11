import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import type { CloneStatus, FolderList } from "../../../shared/protocol";
import { defaultClonePath, parseRepo } from "../../../shared/repo";
import { rpc } from "../connection";

type Tab = "folder" | "clone";

/**
 * New session's Add project: choose a folder on the runner, or clone a GitHub repo into a new one.
 * Either way the chosen folder goes back to the dialog's Folder field.
 */
export function AddProject({ runnerId, onPick, onCancel }: { runnerId: string; onPick: (path: string) => void; onCancel: () => void }) {
  const [tab, setTab] = useState<Tab>("folder");
  return (
    <div className="t-add-proj">
      <div className="t-seg" role="radiogroup" aria-label="Add project">
        {(
          [
            ["folder", "Choose folder"],
            ["clone", "Clone from GitHub"],
          ] as const
        ).map(([id, label]) => (
          <button type="button" role="radio" aria-checked={tab === id} key={id} className={`t-seg-opt${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "folder" ? <FolderBrowser runnerId={runnerId} onPick={onPick} onCancel={onCancel} /> : <CloneForm runnerId={runnerId} onPick={onPick} onCancel={onCancel} />}
    </div>
  );
}

function FolderBrowser({ runnerId, onPick, onCancel }: { runnerId: string; onPick: (path: string) => void; onCancel: () => void }) {
  const [list, setList] = useState<FolderList>();
  const [error, setError] = useState<string>();
  const asked = useRef(0);
  const go = (path: string) => {
    const id = ++asked.current;
    setError(undefined);
    rpc(runnerId, "listFolders", { path })
      .then((l) => id === asked.current && setList(l))
      .catch((e) => id === asked.current && setError((e as Error).message));
  };
  useEffect(() => go("~"), [runnerId]);
  const into = (name: string) => list && go(list.path === "/" ? `/${name}` : `${list.path}/${name}`);
  return (
    <>
      <div className="t-browse-head">
        <Button label="Up" variant="secondary" size="sm" isDisabled={!list?.parent} onClick={() => list?.parent && go(list.parent)} />
        <span className="t-path" title={list?.path}>
          {list?.path ?? "…"}
        </span>
      </div>
      {error && <div className="t-form-error">{error}</div>}
      <div className="t-projects" role="listbox" aria-label="Folders">
        {list?.folders.map((name) => (
          <button type="button" role="option" aria-selected={false} key={name} className="t-proj-opt" onClick={() => into(name)}>
            <span>{name}</span>
          </button>
        ))}
        {list && !list.folders.length && <span className="t-inline-status t-browse-empty">No folders here</span>}
        {list?.more && <span className="t-inline-status t-browse-empty">Only the first {list.folders.length} are listed</span>}
      </div>
      <div className="t-add-proj-actions">
        <Button label="Cancel" variant="secondary" onClick={onCancel} />
        <Button label="Use this folder" variant="primary" isDisabled={!list} onClick={() => list && onPick(list.path)} />
      </div>
    </>
  );
}

function CloneForm({ runnerId, onPick, onCancel }: { runnerId: string; onPick: (path: string) => void; onCancel: () => void }) {
  const [repo, setRepo] = useState("");
  /** what the owner typed for the folder; until then it follows the repo's name */
  const [dest, setDest] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** the running clone and how it goes */
  const [progress, setProgress] = useState<CloneStatus>();
  const cloneId = useRef<string>(undefined);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);
  let parsed: ReturnType<typeof parseRepo> | undefined;
  try {
    parsed = repo.trim() ? parseRepo(repo) : undefined;
  } catch {}
  const path = dest ?? (parsed ? defaultClonePath(parsed.name) : "");
  const clone = async () => {
    if (!parsed || !path.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    setProgress(undefined);
    try {
      const { cloneId: id } = await rpc(runnerId, "cloneRepo", { repo, path: path.trim() });
      cloneId.current = id;
      // The clone runs on the runner; its progress is asked for until it ends.
      for (;;) {
        const st = await rpc(runnerId, "cloneStatus", { cloneId: id });
        if (!live.current || cloneId.current !== id) return;
        if (st.state === "done") return onPick(st.path);
        if (st.state === "failed") {
          if (st.error !== "Canceled.") setError(st.error);
          return;
        }
        setProgress(st);
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) {
        setBusy(false);
        setProgress(undefined);
      }
      cloneId.current = undefined;
    }
  };
  const cancel = () => {
    const id = cloneId.current;
    if (!id) return onCancel();
    cloneId.current = undefined;
    void rpc(runnerId, "cancelClone", { cloneId: id }).catch(() => {});
  };
  const enter = (e: React.KeyboardEvent) => e.key === "Enter" && void clone();
  return (
    <>
      <div>
        <label className="t-field-label" htmlFor="t-clone-repo">
          Repository
        </label>
        <input id="t-clone-repo" className="t-search" disabled={busy} placeholder="org/repo" value={repo} autoComplete="off" autoFocus onChange={(e) => setRepo(e.target.value)} onKeyDown={enter} />
        {parsed && <span className="t-inline-status t-clone-url">{parsed.url}</span>}
        {repo.trim() && !parsed && <span className="t-inline-status error">Use org/repo or a github.com URL.</span>}
      </div>
      <div>
        <label className="t-field-label" htmlFor="t-clone-dest">
          Clone to
        </label>
        <input id="t-clone-dest" className="t-search" disabled={busy} placeholder="~/projects/repo" value={path} autoComplete="off" onChange={(e) => setDest(e.target.value)} onKeyDown={enter} />
      </div>
      {busy && (
        <ProgressBar
          label={[progress?.phase ?? "Starting", progress?.detail].filter(Boolean).join(" · ")}
          value={progress?.percent ?? 0}
          isIndeterminate={progress?.percent === undefined}
          hasValueLabel={progress?.percent !== undefined}
        />
      )}
      {error && <div className="t-form-error">{error}</div>}
      <div className="t-add-proj-actions">
        <Button label={busy ? "Stop" : "Cancel"} variant="secondary" onClick={cancel} />
        <Button label={busy ? "Cloning…" : "Clone"} variant="primary" isDisabled={!parsed || !path.trim() || busy} onClick={() => void clone()} />
      </div>
    </>
  );
}
