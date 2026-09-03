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
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PROJ = "focusproj";

function spawnHub(port, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trantor-focus-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._dir = dir;
  return hub;
}

console.log("# trantor session-focus card tests");

const PORT = 47831, base = `http://127.0.0.1:${PORT}`;
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());
const focus = (session, title, cc) => post("/focus", { session, project: PROJ, title, by: session, ...(cc ? { cc } : {}) });
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

  // 6. cc — the Claude session UUID, and the only per-session key on the board.
  // The bus id (`assignee`) is per HOST+PROJECT: two Claude sessions in one repo share it, so
  // without cc they fought over a single rolling card and sub-agent cards, whose `parent` is that
  // same UUID, had nothing to join to. crebral-health had 28 focus cards on one assignee.
  const S3 = "host:focusproj";                  // deliberately the SAME bus id as S1
  const A = "11111111-aaaa-4aaa-8aaa-111111111111", B = "22222222-bbbb-4bbb-8bbb-222222222222";
  await focus(S3, "session A is doing this", A);
  await focus(S3, "session B is doing something else", B);
  const withCc = (await sessionCards()).filter(t => t.cc);
  ok("two Claude sessions on ONE bus id get TWO focus cards", withCc.length === 2, `(got ${withCc.length})`);
  ok("each card carries its own cc", withCc.some(t => t.cc === A) && withCc.some(t => t.cc === B));
  ok("neither stole the other's title",
    withCc.find(t => t.cc === A)?.title === "session A is doing this" &&
    withCc.find(t => t.cc === B)?.title === "session B is doing something else");
  const idA = withCc.find(t => t.cc === A)?.id;
  await focus(S3, "session A moved on", A);
  const afterA = (await sessionCards()).filter(t => t.cc);
  ok("a refocus still rolls the SAME card, matched by cc", afterA.length === 2 && afterA.find(t => t.cc === A)?.id === idA);
  ok("...and only that session's title changed",
    afterA.find(t => t.cc === A)?.title === "session A moved on" &&
    afterA.find(t => t.cc === B)?.title === "session B is doing something else");
  // GET /focus?cc= is the lookup a sub-agent hook uses to find its parent card
  const lookedUp = await get(`/focus?cc=${B}`);
  ok("GET /focus?cc= returns that session's card", lookedUp.id === afterA.find(t => t.cc === B)?.id);
  ok("GET /focus?session= still answers for older callers", !!(await get(`/focus?session=${encodeURIComponent(S1)}`)).id);
  // 7. a COMMIT closes the focus card it belongs to, and the two link to each other.
  // A focus card otherwise rolls forever — its title changes but it never completes, so a session's
  // finished work never reaches the done lane under its own name.
  const S4 = "host:committer";
  await post("/focus", { session: S4, project: PROJ, title: "wire the badge count", by: S4, cc: "cc-commit-1" });
  const beforeCommit = (await sessionCards()).find(t => t.assignee === S4);
  ok("focus card open before the commit", beforeCommit?.status === "doing");
  const commit = await post("/task", { project: PROJ, title: "badge: fix the off-by-one", status: "done", source: "git", ts: Date.now(), assignee: S4, by: S4 });
  const afterCommit = (await sessionCards()).find(t => t.id === beforeCommit.id);
  ok("the commit closed the focus card", afterCommit?.status === "done", `(got "${afterCommit?.status}")`);
  ok("the focus card points at the commit card", afterCommit?.commitCard === commit.task.id);
  ok("the commit card points back at the focus card", commit.task.focusCard === beforeCommit.id);
  ok("history says WHY it closed", (afterCommit?.history || []).some(h => /closed by commit/.test(h.note || "")));

  // …but a historical backfill must not close whatever a session is doing TODAY
  const S5 = "host:historian";
  await post("/focus", { session: S5, project: PROJ, title: "today's actual work", by: S5, cc: "cc-commit-2" });
  const old = await post("/task", { project: PROJ, title: "ancient: something from last month", status: "done", source: "git", ts: Date.now() - 30 * 24 * 3600 * 1000, assignee: S5, by: S5 });
  const stillOpen = (await sessionCards()).find(t => t.assignee === S5);
  ok("a 30-day-old backfilled commit leaves today's focus alone", stillOpen?.status === "doing", `(got "${stillOpen?.status}")`);
  ok("...and links nothing", !old.task.focusCard);

  // a non-git card must never close a focus card either
  const S6 = "host:noncommit";
  await post("/focus", { session: S6, project: PROJ, title: "work in flight", by: S6, cc: "cc-commit-3" });
  await post("/task", { project: PROJ, title: "some crew card", status: "done", assignee: S6, by: S6 });
  ok("an ordinary done card does not close the focus", (await sessionCards()).find(t => t.assignee === S6)?.status === "doing");
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

  // One bus id can now own SEVERAL open focus cards. The old close() took the first match and
  // left the rest sitting in "doing" forever, which is a dead session the board calls live.
  for (const cc of ["aaaa-1", "aaaa-2", "aaaa-3"]) {
    await fetch(base2 + "/focus", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "multi:focusproj", project: PROJ, title: `work ${cc}`, by: "multi:focusproj", cc }) });
  }
  await sleep(60);
  await fetch(base2 + "/peers");
  const multi = (await fetch(`${base2}/tasks?project=${PROJ}`).then(r => r.json())).tasks.filter(t => t.source === "session" && t.assignee === "multi:focusproj");
  ok("EVERY focus card on a pruned bus id is closed, not just the first",
    multi.length === 3 && multi.every(t => t.status === "done"), `(got ${multi.map(t => t.status).join(",")})`);
} catch (e) {
  fail++; console.log("  ✗ threw (prune):", e?.message || e, herr2 ? `\n  hub stderr: ${herr2}` : "");
} finally {
  hub2.kill(); try { rmSync(hub2._dir, { recursive: true, force: true }); } catch {}
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
