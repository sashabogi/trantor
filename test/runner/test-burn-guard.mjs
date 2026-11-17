#!/usr/bin/env node
// #13474: burn guard, label truth, WIP save at cut, and the stall's probable cause. All pure or on a
// temp repo; nothing reads the machine's processes or load.
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { burnCeiling, afterTurn, burnVerdict } from "../../lib/burn-guard.mjs";
import { providerMismatch, seatProvider } from "../../lib/seat-provider.mjs";
import { saveWip } from "../../lib/wip-save.mjs";
import { stallCause } from "../../lib/stall-cause.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

console.log("# burn guard (#13474)");
ok("ceiling defaults to 1,000,000 and reads the env knob", burnCeiling({}) === 1_000_000 && burnCeiling({ TRANTOR_CARD_TOKEN_BUDGET: "4000" }) === 4000);
// Simulate the runner's loop: the verdict latches through `stopped`, so a stream of turns gives ONE note.
let c = { tokens: 0, commits: 0 }, stopped = false, trips = [];
for (const spent of [400_000, 400_000, 400_000, 400_000]) {
  c = afterTurn(c, { spent, committed: false });
  const v = burnVerdict({ card: 7, ...c, ceiling: 1_000_000, agent: "glm", stopped });
  if (v) { stopped = true; trips.push(v); }
}
ok("parks once, with one verdict, after crossing the ceiling", trips.length === 1 && c.tokens === 1_600_000);
ok("the verdict names tokens spent and commits made", /1200000/.test(trips[0].text) && /0 commit\(s\)/.test(trips[0].note) && /1200000/.test(trips[0].note));
c = { tokens: 900_000, commits: 0 };
c = afterTurn(c, { spent: 500_000, committed: true });
ok("a commit resets the counter and counts the commit", c.tokens === 0 && c.commits === 1);
ok("no verdict below the ceiling, with no card, or with the guard off",
  !burnVerdict({ card: 7, tokens: 999_999, commits: 0, ceiling: 1_000_000, agent: "x" })
  && !burnVerdict({ card: 0, tokens: 9e9, commits: 0, ceiling: 1_000_000, agent: "x" })
  && !burnVerdict({ card: 7, tokens: 9e9, commits: 0, ceiling: 0, agent: "x" }));

console.log("# label truth (#13474)");
const mm = providerMismatch("kimi-13", "deepseek/deepseek-v4-flash");
ok("a subscription label on a metered model is a mismatch", mm && mm.actual === "deepseek" && mm.label === "kimi-13");
ok("codex label on deepseek is a mismatch too", !!providerMismatch("codex", "deepseek/deepseek-v4-pro"));
ok("a subscription label on its own model is fine", !providerMismatch("codex", "gpt-5") && !providerMismatch("kimi", "kimi/k2") && !providerMismatch("codex", "cli-default"));
ok("a provider label on another provider is a mismatch", providerMismatch("glm", "deepseek/x")?.expected === "zai-coding-plan");
ok("a provider label on its own provider is fine", !providerMismatch("deepseek", "deepseek/deepseek-v4-pro") && !providerMismatch("glm", "zai-coding-plan/glm-5"));
ok("an unset model never mismatches", !providerMismatch("glm", "") && seatProvider("opencode") === null);

console.log("# WIP save at cut (#13474)");
const repo = mkdtempSync(join(tmpdir(), "trantor-wip-"));
try {
  const g = (a) => execSync(`git ${a}`, { cwd: repo, stdio: "pipe" }).toString().trim();
  g("init -q -b seat/glm-1");
  writeFileSync(join(repo, "a.txt"), "seed\n");
  g("add -A"); g("-c user.name=t -c user.email=t@t commit -qm init");
  ok("a clean tree saves nothing", saveWip(repo, 13474) === "" && g("rev-list --count HEAD") === "1");
  writeFileSync(join(repo, "big.txt"), "x".repeat(4000));
  const sha = saveWip(repo, 13474);
  ok("uncommitted work becomes a WIP commit on the seat branch", sha && g("log -1 --format=%s") === "WIP(#13474): saved at cut" && g("status --porcelain") === "");
  g("checkout -q -b main");
  writeFileSync(join(repo, "more.txt"), "y");
  ok("never commits on main", saveWip(repo, 13474) === "" && g("status --porcelain") !== "");
} finally { rmSync(repo, { recursive: true, force: true }); }

console.log("# stall cause (#13474)");
ok("high load names the load", /load 21\.0 on 4 CPUs/.test(stallCause({ load: 21, cpuCount: 4, text: "" })));
ok("load at the threshold is not high", stallCause({ load: 32, cpuCount: 8, text: "" }) === "unknown");
ok("an auth signal is named", /auth/.test(stallCause({ load: 1, cpuCount: 8, text: "HTTP 401 Unauthorized" })));
ok("a quota signal is named", /quota/.test(stallCause({ load: 1, cpuCount: 8, text: "429 rate limit" })));
ok("nothing known says unknown", stallCause({ load: 1, cpuCount: 8, text: "" }) === "unknown");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
