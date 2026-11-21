import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLanguageServerPort,
  keepPlan,
  keptPlan,
  parseQuotaSummary,
  poolIdOf,
  windowsIn,
} from "./quota";

const MOCK_QUOTA_RESPONSE = {
  response: {
    groups: [
      {
        displayName: "Gemini Models",
        description: "Models within this group: Gemini 3.8 Flash",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            remainingFraction: 0.96,
            resetTime: "2026-11-27T23:00:42Z",
          },
          {
            bucketId: "gemini-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            remainingFraction: 0.92,
            resetTime: "2026-11-21T10:08:19Z",
          },
        ],
      },
      {
        displayName: "Claude and GPT models",
        description: "Models within this group: Claude Sonnet 4.6, Claude Opus 4.6",
        buckets: [
          {
            bucketId: "3p-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            remainingFraction: 0.47,
            resetTime: "2026-11-28T08:11:02Z",
          },
          {
            bucketId: "3p-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            remainingFraction: 0,
            resetTime: "2026-11-21T13:11:02Z",
          },
        ],
      },
    ],
  },
};

let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-test-"));
  windowsIn(join(tempDir, "antigravity-windows.json"));
});

afterEach(() => {
  windowsIn(undefined);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test("poolIdOf identifies gemini vs other pools", () => {
  expect(poolIdOf("Gemini Models")).toBe("gemini");
  expect(poolIdOf("gemini-pro")).toBe("gemini");
  expect(poolIdOf("Claude and GPT models")).toBe("other");
  expect(poolIdOf("3p models")).toBe("other");
  expect(poolIdOf("Custom Group")).toBe("custom_group");
});

test("parseQuotaSummary parses multi-pool structure with Gemini and Other models", () => {
  const at = Date.UTC(2026, 10, 21, 8, 30);
  const plan = parseQuotaSummary(MOCK_QUOTA_RESPONSE, at);

  expect(plan.complete).toBe(true);
  expect(plan.pools?.length).toBe(2);

  const gemini = plan.pools?.find((p) => p.id === "gemini");
  expect(gemini?.name).toBe("Gemini Models");
  expect(gemini?.fiveHour?.percent).toBe(8); // 1 - 0.92 = 0.08
  expect(gemini?.fiveHour?.resetsAt).toBe(Date.parse("2026-11-21T10:08:19Z"));
  expect(gemini?.fiveHour?.exhausted).toBeUndefined();
  expect(gemini?.week?.percent).toBe(4); // 1 - 0.96 = 0.04
  expect(gemini?.week?.resetsAt).toBe(Date.parse("2026-11-27T23:00:42Z"));

  const other = plan.pools?.find((p) => p.id === "other");
  expect(other?.name).toBe("Claude and GPT models");
  expect(other?.fiveHour?.percent).toBe(100); // 1 - 0 = 1.00
  expect(other?.fiveHour?.exhausted).toBe(true);
  expect(other?.fiveHour?.resetsAt).toBe(Date.parse("2026-11-21T13:11:02Z"));
  expect(other?.week?.percent).toBe(53); // 1 - 0.47 = 0.53

  // Root windows mirror the primary (Gemini) pool
  expect(plan.fiveHour?.percent).toBe(8);
  expect(plan.week?.percent).toBe(4);
});

test("keepPlan and keptPlan persist plan limits to disk", () => {
  const plan = parseQuotaSummary(MOCK_QUOTA_RESPONSE);
  keepPlan(plan);

  const loaded = keptPlan();
  expect(loaded?.pools?.length).toBe(2);
  expect(loaded?.pools?.find((p) => p.id === "gemini")?.fiveHour?.percent).toBe(8);
  expect(loaded?.pools?.find((p) => p.id === "other")?.fiveHour?.percent).toBe(100);
});

test("findLanguageServerPort extracts HTTP port from log file", async () => {
  const pid = 99999;
  const logFile = join(tempDir!, `acp-server-20261121_080000-${pid}.log`);
  writeFileSync(
    logFile,
    `I1121 08:00:00.000000 1 serve.go:30] Starting ACP server (pid ${pid})
I1121 08:00:00.100000 1 server.go:1305] Language server listening on random port at 44397 for HTTPS (gRPC)
I1121 08:00:00.100100 1 server.go:1313] Language server listening on random port at 36015 for HTTP
I1121 08:00:00.200000 1 server.go:4081] initialized server successfully
`
  );

  const port = await findLanguageServerPort(pid, tempDir, 500);
  expect(port).toBe(36015);
});
