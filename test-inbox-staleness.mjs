#!/usr/bin/env node
// trantor desktop — is this inbox message still worth answering?
//
// Asked for 2026-08-24: "there is no point in answering messages or clearing the inbox if the
// project is already moved on. The inbox needs to be aware… whether those messages are already
// stale and have no meaning whatsoever."
//
// The risk in a feature that dims and bulk-dismisses is dismissing something that DID matter, so
// the rules are tested against the real module rather than a description of it: esbuild compiles
// the shipped TypeScript and the assertions run against that.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log("# trantor inbox-staleness drill");

const out = join(mkdtempSync(join(tmpdir(), "tt-stale-")), "staleness.mjs");
execFileSync(join(ROOT, "desktop/node_modules/.bin/esbuild"),
  [join(ROOT, "desktop/src/features/inbox/staleness.ts"), "--format=esm", "--bundle", `--outfile=${out}`],
  { stdio: "ignore" });
const { stalenessOf } = await import(out);

const NOW = 1_800_000_000_000;
const live = (s) => ({ session: s, lastSeen: NOW - 10_000 });
const gone = (s) => ({ session: s, lastSeen: NOW - 60 * 60 * 1000 });
const msg = (id, from, extra = {}) => ({ id, from, to: "sasha@mac", text: "decide something", ts: NOW - 60_000, ...extra });

console.log("\nA live question from a live seat is NOT stale:");
{
  const m = msg(10, "codex:proj");
  ok("stays actionable", stalenessOf(m, [m], [live("codex:proj")], [], NOW).stale === false);
}

console.log("\nAge alone never makes it stale (being slow is not the same as it not mattering):");
{
  const m = msg(11, "codex:proj", { ts: NOW - 9 * 60 * 60 * 1000 });
  ok("9h old but the asker is live → still actionable",
    stalenessOf(m, [m], [live("codex:proj")], [], NOW).stale === false);
}

console.log("\nThe asker being gone makes it stale:");
{
  const m = msg(12, "glm:proj");
  const r = stalenessOf(m, [m], [gone("glm:proj")], [], NOW);
  ok("a long-silent seat is stale", r.stale === true, JSON.stringify(r));
  ok("…and the reason says so, without claiming it never mattered", /gone a while/.test(r.reason), r.reason);
  const r2 = stalenessOf(m, [m], [], [], NOW);
  ok("a seat that is not on the bus at all is stale", r2.stale === true && /not on the bus/.test(r2.reason), JSON.stringify(r2));
}

console.log("\nA closed card makes it stale — but only when EVERY cited card is closed:");
{
  const m = msg(13, "codex:proj", { refs: [5038, 5041] });
  const peers = [live("codex:proj")];
  const bothDone = [{ id: 5038, status: "done" }, { id: 5041, status: "failed" }];
  const oneOpen = [{ id: 5038, status: "done" }, { id: 5041, status: "doing" }];
  const r = stalenessOf(m, [m], peers, bothDone, NOW);
  ok("all cited cards closed → stale", r.stale === true, JSON.stringify(r));
  ok("…naming the cards", /#5038/.test(r.reason) && /#5041/.test(r.reason), r.reason);
  ok("one card still open → NOT stale", stalenessOf(m, [m], peers, oneOpen, NOW).stale === false);
  const unknown = stalenessOf(m, [m], peers, [{ id: 5038, status: "done" }], NOW);
  ok("a card the board does not know is not treated as closed", unknown.stale === false, JSON.stringify(unknown));
}

console.log("\nAsking again supersedes the older question:");
{
  const older = msg(14, "codex:proj");
  const newer = msg(15, "codex:proj");
  const all = [older, newer];
  const peers = [live("codex:proj")];
  const r = stalenessOf(older, all, peers, [], NOW);
  ok("the older one is stale", r.stale === true && /asked again/.test(r.reason), JSON.stringify(r));
  ok("the newest one is still live", stalenessOf(newer, all, peers, [], NOW).stale === false);
  ok("another seat's message is unaffected",
    stalenessOf(msg(16, "kimi:proj"), [...all, msg(16, "kimi:proj")], [live("kimi:proj")], [], NOW).stale === false);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} inbox-staleness: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
