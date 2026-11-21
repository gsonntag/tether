import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { cleanEmail, type RunnerGrant } from "../../../shared/access";
import type { RunnerBuild } from "../../../shared/protocol";
import { rpc } from "../connection";
import { accessOf, type KnownRunner } from "../runners";
import { useStore } from "../store";

/**
 * Settings → Runners (owners only): each runner you own, its name, and who else it's shared with.
 * People need a share on the Tether app in Foliation first; here you pick which runners they see
 * and whether they can drive them or only view. A viewer share on Foliation only ever views.
 */
export function RunnersSettings() {
  const runners = useStore((s) => s.runners).filter((r) => accessOf(r) === "manage");
  const serverBuild = useStore((s) => s.serverBuild);
  if (!runners.length) return <div className="t-inline-status">No runners of yours have connected yet.</div>;
  return (
    <>
      <p className="t-settings-note">
        Share Tether with someone in Foliation first. They see no runners until you add them to one here. "Can drive" lets them send messages and use terminals. "Can view" lets them read sessions only. Someone with a viewer share in Foliation can only view.
      </p>
      {runners.map((r) => <RunnerCard key={r.id} runner={r} serverBuild={serverBuild} />)}
    </>
  );
}

export function RunnerCard({ runner, serverBuild: propServerBuild }: { runner: KnownRunner; serverBuild?: RunnerBuild }) {
  const linkOpen = useStore((s) => s.link === "open");
  const storeServerBuild = useStore((s) => s.serverBuild);
  const serverBuild = propServerBuild ?? storeServerBuild;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<RunnerGrant["access"]>("view");
  const people = runner.shared ?? [];
  const disabled = busy || !linkOpen || !runner.online;
  const build = runner.build;
  const versionText = build ? `${build.commit} · ${build.date}${build.dirty ? " · local changes" : ""}` : runner.version;
  const differentBuild = !!(serverBuild?.commit && build?.commit && serverBuild.commit !== build.commit);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
      return true;
    } catch (e) {
      setError((e as Error)?.message || "Couldn't save. Update and restart the runner.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  // The runner says hello again with the new list, so the page follows from the runners frame.
  const save = (next: RunnerGrant[]) => run(() => rpc(runner.id, "setRunnerAccess", { people: next }));

  const add = async () => {
    const e = cleanEmail(email);
    if (!e) return setError("Enter an email address.");
    if (people.some((p) => p.email === e)) return setError("Already shared with them.");
    if (await save([...people, { email: e, access: level }])) setEmail("");
  };

  return (
    <section className="t-credential-harness t-runner-card" aria-label={runner.name || runner.id}>
      <Heading level={3}>
        {runner.name || runner.id}
        {!runner.online && <span className="t-credential-status"> · offline</span>}
      </Heading>
      <div className="t-usage-note">
        <span>{versionText}</span>
        {differentBuild && <div>Different from the app's build ({serverBuild!.commit}): restart the runner to update</div>}
      </div>
      <NameField runner={runner} disabled={disabled} run={run} />
      <div className="t-share-list" role="list" aria-label="Shared with">
        {people.length === 0 ? (
          <div className="t-inline-status">Not shared with anyone.</div>
        ) : (
          people.map((p) => (
            <div key={p.email} className="t-share-row" role="listitem">
              <span className="t-share-email">{p.email}</span>
              <select
                className="t-select"
                aria-label={`Access for ${p.email}`}
                value={p.access}
                disabled={disabled}
                onChange={(e) => void save(people.map((x) => (x.email === p.email ? { ...x, access: e.target.value as RunnerGrant["access"] } : x)))}
              >
                <option value="view">Can view</option>
                <option value="drive">Can drive</option>
              </select>
              <Button label="Remove" variant="secondary" size="sm" isDisabled={disabled} onClick={() => void save(people.filter((x) => x.email !== p.email))} />
            </div>
          ))
        )}
      </div>
      <form
        className="t-credential-entry"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) void add();
        }}
      >
        <input className="t-search" type="email" placeholder="Email to share with" aria-label={`Share ${runner.name || runner.id} with`} autoCapitalize="off" autoCorrect="off" spellCheck={false} value={email} disabled={disabled} onChange={(e) => setEmail(e.currentTarget.value)} />
        <select className="t-select" aria-label="Access" value={level} disabled={disabled} onChange={(e) => setLevel(e.target.value as RunnerGrant["access"])}>
          <option value="view">Can view</option>
          <option value="drive">Can drive</option>
        </select>
        <Button label="Share" variant="primary" type="submit" isDisabled={disabled || !email.trim()} />
      </form>
      {error && <div className="t-inline-status error" role="alert">{error}</div>}
    </section>
  );
}

function NameField({ runner, disabled, run }: { runner: KnownRunner; disabled: boolean; run: (f: () => Promise<unknown>) => Promise<boolean> }) {
  const [name, setName] = useState(runner.name);
  const [was, setWas] = useState(runner.name);
  // Follow a rename from elsewhere (Home, another device) unless it's being edited.
  if (runner.name !== was) {
    setWas(runner.name);
    setName(runner.name);
  }
  const changed = name.trim() !== runner.name;
  return (
    <form
      className="t-credential-entry"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && changed) void run(() => rpc(runner.id, "setRunnerName", { name: name.trim() }));
      }}
    >
      <input className="t-search" aria-label={`Name of ${runner.name || runner.id}`} placeholder="Name (blank for default)" maxLength={60} value={name} disabled={disabled} onChange={(e) => setName(e.currentTarget.value)} />
      <Button label="Rename" variant="secondary" type="submit" isDisabled={disabled || !changed} />
    </form>
  );
}
