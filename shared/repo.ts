// GitHub repos for Add project (runner/src/core/addProject.ts): whatever form one is typed in, it
// is cloned over SSH so the runner machine's own key signs in.

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * `org/repo` and the GitHub URL forms (`github.com/org/repo`, `https://github.com/org/repo(.git)`,
 * `git@github.com:org/repo(.git)`, `ssh://git@github.com/org/repo`) as the SSH URL to clone and the
 * repo's name. Anything else is refused.
 */
export function parseRepo(input: string): { url: string; org: string; name: string } {
  const s = input.trim().replace(/\/+$/, "");
  const m = s.match(/^(?:(?:https?:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[:/])?([^/:\s]+)\/([^/:\s]+?)(?:\.git)?$/);
  const [org, name] = [m?.[1], m?.[2]];
  if (!org || !name || !NAME.test(org) || !NAME.test(name) || org.startsWith(".") || org.startsWith("-") || name.startsWith(".") || name.startsWith("-")) {
    throw new Error(`Not a GitHub repo: ${s || "(empty)"}. Use org/repo.`);
  }
  return { url: `git@github.com:${org}/${name}.git`, org, name };
}

/** Where a repo is cloned unless the owner says otherwise. */
export const defaultClonePath = (name: string) => `~/projects/${name}`;
