#!/usr/bin/env bun
// Short, cheap compatibility checks for Antigravity (issue #121).
// Verifies Tether's integration with agy: ACP server, store & fork, subagents, and terminal screen.
// Usable by hand before trusting a new agy version, and run automatically by the runner when agy updates.
//
//   bun scripts/antigravity-compat.ts [--live] [--bin <path>]
//
// Spends zero tokens by default. Pass --live to also run a live 1-turn prompt test.

import { checkAntigravityCompatibility } from "../runner/src/adapters/antigravity/compat";

const live = process.argv.includes("--live");
const binIdx = process.argv.indexOf("--bin");
const bin = binIdx >= 0 ? process.argv[binIdx + 1] : undefined;

console.log(`Checking Antigravity compatibility${live ? " (with live turn)" : ""}${bin ? ` using ${bin}` : ""}...`);
const result = await checkAntigravityCompatibility({ bin, live });
console.log(result.output);

if (!result.ok) {
  process.exit(1);
}
