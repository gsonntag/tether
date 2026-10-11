// The user's home for runner code: $HOME first, else os.homedir(). Bun's os.homedir() doesn't
// follow a HOME set at runtime, so tests' scratch homes (testenv.ts) would be bypassed and a test
// could read the real logins. The only module that calls homedir() (a test checks that).

import { homedir } from "node:os";

export const userHome = () => process.env.HOME || homedir();
