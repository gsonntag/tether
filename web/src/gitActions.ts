// What the git actions show (SPEC §10 Git actions): the PR chip's words and tone, the branch line in
// the Changes pane header, and which actions apply. Pure, so it's tested without a browser.

import type { GitStatus, PrInfo, PrLookup } from "../../shared/gitActions";

export type Tone = "ok" | "bad" | "pending" | "muted";

const STATE: Record<PrInfo["state"], string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const CHECKS: Record<PrInfo["checks"], string> = { passing: "Checks passing", failing: "Checks failing", pending: "Checks running", none: "" };

/** The PR chip: "#42 · Open · ✓" (✗ failing, ● running), its tone (from checks while it's open, else its state), its tooltip, and its label in words for a screen reader. */
export function prChip(pr: PrInfo): { text: string; tone: Tone; title: string; label: string } {
  const live = pr.state === "open" || pr.state === "draft";
  const mark = !live ? "" : pr.checks === "passing" ? " · ✓" : pr.checks === "failing" ? " · ✗" : pr.checks === "pending" ? " · ●" : "";
  const tone: Tone = !live ? (pr.state === "merged" ? "ok" : "muted") : pr.checks === "failing" ? "bad" : pr.checks === "pending" ? "pending" : pr.checks === "passing" ? "ok" : "muted";
  const checks = live && CHECKS[pr.checks] ? `, ${CHECKS[pr.checks].toLowerCase()}` : "";
  return {
    text: `#${pr.number} · ${STATE[pr.state]}${mark}`,
    tone,
    title: `${pr.title ? `${pr.title}: ` : ""}${STATE[pr.state].toLowerCase()}${checks}. Opens on GitHub.`,
    label: `Pull request ${pr.number}, ${STATE[pr.state].toLowerCase()}${checks}`,
  };
}

/** Why there's no PR to show, when that's worth saying in the pane; undefined when gh is fine. */
export function ghNote(l: PrLookup | undefined): string | undefined {
  if (!l) return undefined;
  if (l.gh === "missing") return "gh isn't installed on this computer, so PRs can't be opened or shown.";
  if (l.gh === "unauthed") return "gh isn't signed in on this computer. Run gh auth login there.";
  if (l.gh === "notGithub") return "origin isn't on GitHub: no PRs.";
  if (l.gh === "error") return `gh: ${l.error ?? "failed"}`;
  return undefined;
}

/** The branch line: "feature → origin/feature · 2 ahead · 1 behind", or what stands in for it. */
export function branchLine(s: GitStatus): string {
  if (s.state !== "ok") return "Not a git repository";
  const name = s.branch ?? `detached at ${s.head ?? "?"}`;
  if (!s.upstream) return s.branch ? `${name} · not pushed` : name;
  const parts = [`${name} → ${s.upstream}`];
  if (s.ahead) parts.push(`${s.ahead} ahead`);
  if (s.behind) parts.push(`${s.behind} behind`);
  if (!s.ahead && !s.behind) parts.push("up to date");
  return parts.join(" · ");
}

/** What each action can do now; a reason when it can't (shown as its tooltip and under it). */
export function actionsFor(s: GitStatus, l: PrLookup | undefined): { commit?: string; push?: string; pr?: string } {
  if (s.state !== "ok") return { commit: "Not a git repository.", push: "Not a git repository.", pr: "Not a git repository." };
  const detached = s.branch ? undefined : "HEAD is detached.";
  return {
    commit: detached ?? (!s.changed ? "Nothing to commit." : undefined),
    push: detached ?? (!s.origin ? "No remote called origin." : !s.head ? "No commits yet." : s.upstream && !s.ahead ? "Nothing to push." : undefined),
    pr:
      detached ??
      (!s.origin
        ? "No remote called origin."
        : !s.defaultBranch
          ? "No default branch to open a PR against."
          : s.branch === s.defaultBranch
            ? `A PR needs a branch other than ${s.defaultBranch}.`
            : l?.gh === "missing"
              ? "gh isn't installed on this computer."
              : l?.pr && (l.pr.state === "open" || l.pr.state === "draft") && l.pr.branch === s.branch
                ? `#${l.pr.number} is open for this branch.`
                : undefined),
  };
}
