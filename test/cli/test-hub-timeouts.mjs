#!/usr/bin/env node
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "trantor-hub-timeouts-"));
try {
  const now = new Date();
  const ts = new Date(now.getTime() - 30_000).toISOString();
  const stamp = ts.replace("T", " ").replace("Z", "Z");
  const receipts = join(dir, "receipts.jsonl");
  const journal = join(dir, "journal.log");
  writeFileSync(receipts, `${JSON.stringify({ ts, route: "/task/update", op: "abc", elapsedMs: 8001, hubUrl: "http://hub" })}\n`);
  writeFileSync(journal, `${stamp} netcup trantor-hub[1]: [trantor] event-loop stall duration=700ms\n${stamp} netcup trantor-hub[1]: ordinary line\n`);
  const run = spawnSync(process.execPath, [join(root, "bin/cli.mjs"), "hub", "timeouts", "--since", "1h"], {
    encoding: "utf8", env: { ...process.env, AGENT_BUS_DIR: dir, TRANTOR_HUB_TIMEOUTS_FILE: receipts, TRANTOR_HUB_JOURNAL_FILE: journal },
  });
  const output = run.stdout;
  const ok = run.status === 0 && output.indexOf("client timeout") >= 0 && output.indexOf("event-loop stall") >= 0
    && output.indexOf("client timeout") < output.indexOf("event-loop stall") && !output.includes("ordinary line") && output.includes("local journal only");
  console.log(`  ${ok ? "✓" : "✗"} CLI merges fixture receipts and hub journal in timestamp order (local-only stated)`);
  if (!ok) { console.log(output, run.stderr); process.exitCode = 1; }
} finally { rmSync(dir, { recursive: true, force: true }); }
