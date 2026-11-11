// The runner-wide settings (the Settings page, kept in runner.json by Prefs), for code with no
// handle on the runner's Prefs, such as a harness driver. createRunner points it at its Prefs.

import type { RunnerSettings } from "../../../shared/protocol";

let source: () => RunnerSettings = () => ({});

/** The runner's settings as they are now. */
export const runnerSettings = (): RunnerSettings => source();

/** Where runnerSettings reads from (createRunner). */
export function readRunnerSettingsFrom(read: () => RunnerSettings) {
  source = read;
}
