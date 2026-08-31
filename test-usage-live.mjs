#!/usr/bin/env node
// USAGE v2 contract test — the statusline sidechannel's hub half (/usage/claude):
// live windows PATCH the cached balances snapshot, same-value posts dedupe inside 30s,
// an empty payload refuses, and a full `trantor balances` push still wins the shape.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor live-usage tests (statusline sidechannel, hub half)");
const W = mkdtempSync(join(tmpdir(), "trantor-usage-"));
// GET /balances scopes server-side to the operator's PROFILE (never stray keys) — seed one, or
// the drill's providers are filtered out and every assertion reads an empty list.
mkdirSync(join(W, ".agent-bus"), { recursive: true });
writeFileSync(join(W, ".agent-bus", "profile.json"), JSON.stringify({ providers: { claude: "max", codex: "plus" } }));
const PORT = 47881, BASE = `http://127.0.0.1:${PORT}`;
const hub = spawn("node", [join(ROOT, "hub.mjs")], {
  cwd: ROOT,
  env: { ...process.env, HOME: W, RELAY_DATA_DIR: W, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
let er = ""; hub.stderr.on("data", d => { er += d; });
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(BASE + "/health")).ok; } catch {} if (!up) await sleep(100); }
  if (!up) throw new Error("hub no start: " + er.slice(-300));

  // A normal balances snapshot first — the sidechannel must PATCH it, not clobber it.
  await post("/balances", { ts: Date.now(), by: "t", balances: [
    { provider: "claude", label: "Claude", kind: "windows", ok: true, windows: [{ name: "5h", usedPct: 40, resetsAt: 1 }, { name: "Fable", usedPct: 57, resetsAt: 2 }] },
    { provider: "codex", label: "Codex", kind: "windows", ok: true, windows: [{ name: "5h", usedPct: 7 }] },
  ] });

  // Live post in the statusline payload shape (used_percentage / resets_at, seconds epoch).
  let r = await post("/usage/claude", { fiveHour: { used_percentage: 44.6, resets_at: 1788200000 }, sevenDay: { utilization: 41 } });
  ok("a live post is accepted", r.status === 200, String(r.status));
  let bal = (await (await fetch(BASE + "/balances")).json());
  const claude = (bal.balances?.entries || bal.entries || []).find(e => e.provider === "claude");
  ok("the 5h window is PATCHED live (40 → 45)", claude?.windows?.find(w => w.name === "5h")?.usedPct === 45, JSON.stringify(claude?.windows));
  ok("a window the post lacked survives untouched (Fable keeps 57)", claude?.windows?.find(w => w.name === "Fable")?.usedPct === 57);
  ok("the entry is stamped live (liveTs + source)", claude?.liveTs > 0 && claude?.liveSource === "statusline");
  const codex = (bal.balances?.entries || bal.entries || []).find(e => e.provider === "codex");
  ok("other providers are untouched", codex?.windows?.[0]?.usedPct === 7);

  // Same values again inside 30s → deduped, no work.
  r = await post("/usage/claude", { fiveHour: { used_percentage: 44.6, resets_at: 1788200000 }, sevenDay: { utilization: 41 } });
  ok("a same-value post inside 30s dedupes", (await r.json()).deduped === true);

  // Garbage refuses loudly.
  r = await post("/usage/claude", { hello: "nothing here" });
  ok("a payload with no usable windows is a 400", r.status === 400);
} catch (e) {
  ok("suite ran", false, String(e?.stack || e).slice(0, 300));
} finally {
  hub.kill(); await sleep(200);
  rmSync(W, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
