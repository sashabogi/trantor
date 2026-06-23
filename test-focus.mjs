#!/usr/bin/env node
// trantor session-focus card tests — the "regular session" bridge (2026-06-23).
//
// A non-crew Claude session's OWN work was invisible on the board until it committed/dispatched a sub-agent.
// hooks/prompt-focus.mjs (UserPromptSubmit) now POSTs /focus on each substantive prompt; the hub keeps ONE
// rolling "doing" card per session (source:"session"), re-titled as the focus shifts, auto-closed to "done"
// when the session is pruned offline. These tests spin up the REAL hub.mjs and assert the /focus contract.
// (The hook's ack-filter / title-cleanup is verified separately; this locks the durable hub behavior.)
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PROJ = "focusproj";

function spawnHub(port, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trantor-focus-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...process.env, RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._dir = dir;
  return hub;
}

console.log("# trantor session-focus card tests");

const PORT = 47831, base = `http://127.0.0.1:${PORT}`;
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());
const focus = (session, title) => post("/focus", { session, project: PROJ, title, by: session });
const sessionCards = async () => (await get(`/tasks?project=${PROJ}`)).tasks.filter(t => t.source === "session");

try { await fetch(`${base}/health`, { signal: AbortSignal.timeout(700) }); console.error(`✗ something already listening on :${PORT}`); process.exit(2); } catch {}
const hub = spawnHub(PORT);
let herr = ""; hub.stderr.on("data", d => herr += d);
await sleep(800);

try {
  const S1 = "host:focusproj", S2 = "codex:focusproj";

  // 1. first prompt → ONE doing card for the session
  await focus(S1, "Build the per-project full-window view");
  let mine = (await sessionCards()).filter(t => t.assignee === S1);
  ok("first prompt creates a focus card", mine.length === 1, `(got ${mine.length})`);
  ok("focus card is doing", mine[0]?.status === "doing", `(got "${mine[0]?.status}")`);
  ok("focus card titled from prompt", mine[0]?.title === "Build the per-project full-window view");
  const id1 = mine[0]?.id;

  // 2. same title again → no new card, same id
  await focus(S1, "Build the per-project full-window view");
  mine = (await sessionCards()).filter(t => t.assignee === S1);
  ok("re-posting same title does not duplicate", mine.length === 1 && mine[0].id === id1, `(got ${mine.length})`);

  // 3. new prompt → SAME card re-titled in place (rolling), history records the shift
  await focus(S1, "Now fix Bug 2 in-flight cards");
  mine = (await sessionCards()).filter(t => t.assignee === S1);
  ok("refocus keeps ONE card", mine.length === 1, `(got ${mine.length})`);
  ok("refocus is the SAME card (re-titled in place)", mine[0]?.id === id1, `(id ${mine[0]?.id} vs ${id1})`);
  ok("refocus updated the title", mine[0]?.title === "Now fix Bug 2 in-flight cards", `(got "${mine[0]?.title}")`);
  ok("refocus recorded in history trail", (mine[0]?.history || []).some(h => h.note === "Now fix Bug 2 in-flight cards"));
  ok("refocus stays doing", mine[0]?.status === "doing");

  // 4. a different session gets its OWN focus card
  await focus(S2, "Research session naming");
  const s2cards = (await sessionCards()).filter(t => t.assignee === S2);
  ok("a second session gets its own focus card", s2cards.length === 1 && s2cards[0].assignee === S2);
  ok("two sessions → two focus cards total", (await sessionCards()).length === 2);

  // 5. validation: missing fields rejected
  const bad = await post("/focus", { session: S1, project: PROJ });   // no title
  ok("missing title is rejected", !!bad.error);
} catch (e) {
  fail++; console.log("  ✗ threw:", e?.message || e, herr ? `\n  hub stderr: ${herr}` : "");
} finally {
  hub.kill(); try { rmSync(hub._dir, { recursive: true, force: true }); } catch {}
}

// 6. prune-close: a fresh hub with tiny online/TTL windows → a stale session's focus auto-closes to "done"
const PORT2 = 47832, base2 = `http://127.0.0.1:${PORT2}`;
const hub2 = spawnHub(PORT2, { RELAY_ONLINE_MS: "1", RELAY_PEER_TTL_MS: "1" });
let herr2 = ""; hub2.stderr.on("data", d => herr2 += d);
await sleep(800);
try {
  await fetch(base2 + "/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: "host:focusproj", project: PROJ, title: "work that will go stale", by: "host:focusproj" }) });
  let f = (await fetch(`${base2}/tasks?project=${PROJ}`).then(r => r.json())).tasks.filter(t => t.source === "session");
  ok("focus card starts doing", f[0]?.status === "doing", `(got "${f[0]?.status}")`);
  await sleep(60);
  await fetch(base2 + "/peers");   // any read triggers prunePeers(); stale peer → closeFocus()
  f = (await fetch(`${base2}/tasks?project=${PROJ}`).then(r => r.json())).tasks.filter(t => t.source === "session");
  ok("pruned session → focus auto-closed to done", f[0]?.status === "done", `(got "${f[0]?.status}")`);
} catch (e) {
  fail++; console.log("  ✗ threw (prune):", e?.message || e, herr2 ? `\n  hub stderr: ${herr2}` : "");
} finally {
  hub2.kill(); try { rmSync(hub2._dir, { recursive: true, force: true }); } catch {}
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
