#!/usr/bin/env node
// trantor agent-proposed permissions (governance) tests — v0.17.68.
//
// The autonomy ladder made two-directional: agents FILE bounded proposals, the human decides.
// Three promises the design rests on, each enforced hub-side and each tested here:
//   1. THE BOUND IS MANDATORY. scope + condition + exclusions or it's a 400 — "a permission
//      without a bound is a blank cheque".
//   2. THE QUEUE IS CAPPED per session (3 pending). Filing past the cap is refused until the
//      agent withdraws one of its OWN — and only the proposer can withdraw.
//   3. DENIALS ARE REMEMBERED. A near-duplicate re-propose (normalized scope+condition, same
//      project) is refused WITH the operator's note — and the memory survives a hub restart.
// Plus: deciding is owner-gated under enforce (never auto, never agent-side), decisions DM the
// proposer, and everything lands in the ONE event log so the app streams it.
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

function spawnHub(port, { dir = null, extraEnv = {} } = {}) {
  const d = dir || mkdtempSync(join(tmpdir(), "trantor-prop-"));
  mkdirSync(join(d, ".agent-bus"), { recursive: true });
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: d, HOME: d, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._dir = d;
  return hub;
}
const mk = (base) => ({
  post: (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, ...(await r.json()) })),
  get: (p) => fetch(base + p).then(r => r.json()),
});

const BOUND = (n) => ({ scope: `push to main in repo ${n}`, condition: "only after npm test exits 0", exclusions: "never force-push" });

console.log("# trantor agent-proposed permissions tests");

// ── Hub A (warn mode): bound rule, cap, withdraw, denial memory, events, restart survival ────────
const PA = 47941;
let hubA = spawnHub(PA);
let errA = ""; hubA.stderr.on("data", d => errA += d);
await sleep(800);
const dirA = hubA._dir;
try {
  const A = mk(`http://127.0.0.1:${PA}`);
  const S = "codex:govtest";

  console.log("\n[1] the bound is mandatory:");
  const noBound = await A.post("/propose", { session: S, project: "govtest", scope: "do everything forever" });
  ok("unbounded proposal -> 400", noBound.status === 400, `got ${noBound.status}`);
  ok("400 explains the bound rule", /blank cheque/.test(noBound.error || ""), noBound.error);
  const noSession = await A.post("/propose", { project: "govtest", ...BOUND(0) });
  ok("no session -> 400", noSession.status === 400, `got ${noSession.status}`);

  console.log("\n[2] a bounded proposal files as pending + hits the event log:");
  const p1 = await A.post("/propose", { session: S, project: "govtest", ...BOUND(1) });
  ok("files pending", p1.ok === true && p1.proposal?.status === "pending", JSON.stringify(p1));
  const evs = await A.get("/events?type=proposal.&project=govtest");
  ok("proposal.filed in the unified log", evs.events?.some(e => e.type === "proposal.filed" && e.proposalId === p1.proposal.id));
  const hist = await A.get("/history?project=govtest");
  ok("/history stays card-only (no proposal leak)", !(hist.events || []).some(e => String(e.type).startsWith("proposal")));

  console.log("\n[3] identical re-file dedups; queue caps at 3 pending per session:");
  const p1b = await A.post("/propose", { session: S, project: "govtest", ...BOUND(1) });
  ok("identical re-file -> dedup, same id", p1b.dedup === true && p1b.proposal?.id === p1.proposal.id, JSON.stringify(p1b));
  const p2 = await A.post("/propose", { session: S, project: "govtest", ...BOUND(2) });
  const p3 = await A.post("/propose", { session: S, project: "govtest", ...BOUND(3) });
  ok("second + third file fine", p2.ok === true && p3.ok === true);
  const p4 = await A.post("/propose", { session: S, project: "govtest", ...BOUND(4) });
  ok("fourth -> 409 queue full", p4.status === 409 && /queue full/.test(p4.error || ""), JSON.stringify(p4));
  ok("refusal lists the pending queue", Array.isArray(p4.pending) && p4.pending.length === 3);

  console.log("\n[4] withdraw: own-only, frees a slot:");
  const wOther = await A.post("/proposal/withdraw", { id: p3.proposal.id, session: "kimi:govtest" });
  ok("another session cannot withdraw -> 403", wOther.status === 403, `got ${wOther.status}`);
  const w = await A.post("/proposal/withdraw", { id: p3.proposal.id, session: S });
  ok("proposer withdraws", w.ok === true && w.proposal.status === "withdrawn");
  const wAgain = await A.post("/proposal/withdraw", { id: p3.proposal.id, session: S });
  ok("re-withdraw -> 409 already withdrawn", wAgain.status === 409);
  const p4b = await A.post("/propose", { session: S, project: "govtest", ...BOUND(4) });
  ok("slot freed — fourth now files", p4b.ok === true && p4b.proposal?.status === "pending", JSON.stringify(p4b));

  console.log("\n[5] deny with a note; the proposer is told; the denial is REMEMBERED:");
  const d = await A.post("/proposal/decide", { id: p1.proposal.id, status: "denied", note: "main is protected; use PRs", by: "sasha" });
  ok("denied", d.ok === true && d.proposal.status === "denied" && d.proposal.note === "main is protected; use PRs", JSON.stringify(d));
  const inbox = await A.get(`/inbox?session=${encodeURIComponent(S)}&since=0&peek=1`);
  ok("proposer got a decision DM", (inbox.messages || []).some(m => m.from === "hub:duty" && /DENIED/.test(m.text) && m.text.includes(`#${p1.proposal.id}`)));
  // near-duplicate: same ask, different case/punctuation — the normalized compare must catch it
  const re1 = await A.post("/propose", { session: S, project: "govtest", scope: "PUSH to main -- in repo 1!", condition: "Only after NPM TEST exits 0.", exclusions: "totally different exclusions" });
  ok("near-duplicate of a denial -> 409", re1.status === 409 && /denied/i.test(re1.error || ""), JSON.stringify(re1));
  ok("refusal carries the operator's note", re1.note === "main is protected; use PRs");
  const reOther = await A.post("/propose", { session: "kimi:govtest", project: "govtest", ...BOUND(1) });
  ok("denial binds the PROJECT — another session is refused too", reOther.status === 409, JSON.stringify(reOther));

  console.log("\n[6] approve; decided proposals are settled:");
  const ap = await A.post("/proposal/decide", { id: p2.proposal.id, status: "approved", note: "within the stated bound only", by: "sasha" });
  ok("approved", ap.ok === true && ap.proposal.status === "approved");
  const evs2 = await A.get("/events?type=proposal.decided&project=govtest");
  ok("both decisions in the log", (evs2.events || []).filter(e => e.type === "proposal.decided").length === 2);
  const reDecide = await A.post("/proposal/decide", { id: p2.proposal.id, status: "denied", by: "sasha" });
  ok("re-deciding a settled proposal -> 409", reDecide.status === 409);
  const badStatus = await A.post("/proposal/decide", { id: p4b.proposal.id, status: "maybe", by: "sasha" });
  ok("bogus status -> 400", badStatus.status === 400);

  console.log("\n[7] /proposals filters:");
  const all = await A.get("/proposals?project=govtest");
  ok("lists every proposal", (all.proposals || []).length === 4, `got ${all.proposals?.length}`);   // p1 denied · p2 approved · p3 withdrawn · p4b pending
  const pend = await A.get("/proposals?status=pending");
  ok("status filter + pendingCount agree", (pend.proposals || []).length === pend.pendingCount && pend.pendingCount === 1, JSON.stringify({ n: pend.proposals?.length, c: pend.pendingCount }));
  const mine = await A.get(`/proposals?session=${encodeURIComponent(S)}`);
  ok("session filter", (mine.proposals || []).every(p => p.session === S) && (mine.proposals || []).length === 4, `got ${mine.proposals?.length}`);

  console.log("\n[8] the denial memory survives a hub restart (JSON store):");
  await sleep(1500);                                  // let the 1s persist tick flush
  hubA.kill(); await sleep(300);
  hubA = spawnHub(PA, { dir: dirA });
  hubA.stderr.on("data", d => errA += d);
  await sleep(800);
  const re2 = await A.post("/propose", { session: S, project: "govtest", ...BOUND(1) });
  ok("denied memory survives restart -> 409", re2.status === 409 && re2.note === "main is protected; use PRs", JSON.stringify(re2));
  const afterRestart = await A.get("/proposals?project=govtest");
  ok("proposals survive restart", (afterRestart.proposals || []).length === 4, `got ${afterRestart.proposals?.length}`);
  const p5 = await A.post("/propose", { session: S, project: "govtest", ...BOUND(5) });
  ok("proposalSeq survives restart (fresh id, no collision)", p5.ok === true && !afterRestart.proposals.some(x => x.id === p5.proposal.id), JSON.stringify(p5.proposal?.id));

  console.log("\n[9] grants — the mechanical face of approvals (key · /grants · revoke):");
  const S2 = "codex:grantstest";   // own session+project: no interplay with the cap/count checks above
  const KB = { scope: "reap provably-dead orphan runners during patrol", condition: "process gone AND row stale >24h", exclusions: "never a live process" };
  const kp = await A.post("/propose", { session: S2, project: "grantstest", ...KB, key: "patrol.reap-orphans" });
  ok("keyed proposal files (key stored)", kp.ok === true && kp.proposal.key === "patrol.reap-orphans", JSON.stringify(kp.proposal || kp));
  const badKey = await A.post("/propose", { session: S2, project: "grantstest", scope: "x", condition: "y", exclusions: "z", key: "Not A Slug!" });
  ok("malformed key -> 400", badKey.status === 400, `got ${badKey.status}`);
  const g0 = await A.get("/grants?project=grantstest");
  ok("a PENDING proposal is not a grant", (g0.grants || []).length === 0, JSON.stringify(g0.grants));
  const rvEarly = await A.post("/proposal/decide", { id: kp.proposal.id, status: "revoked", by: "sasha@test" });
  ok("cannot revoke a pending proposal -> 409", rvEarly.status === 409, `got ${rvEarly.status}`);
  await A.post("/proposal/decide", { id: kp.proposal.id, status: "approved", note: "bounded, fine", by: "sasha@test" });
  const g1 = await A.get("/grants?project=grantstest&key=patrol.reap-orphans");
  ok("approved keyed proposal IS a grant (exact key filter)", g1.grants?.length === 1 && g1.grants[0].id === kp.proposal.id && g1.grants[0].key === "patrol.reap-orphans", JSON.stringify(g1.grants));
  const gOtherKey = await A.get("/grants?project=grantstest&key=other.key");
  ok("key filter is exact (no prose matching)", (gOtherKey.grants || []).length === 0, JSON.stringify(gOtherKey.grants));
  const rv = await A.post("/proposal/decide", { id: kp.proposal.id, status: "revoked", note: "changed my mind", by: "sasha@test" });
  ok("owner revokes an approved grant", rv.ok === true && rv.proposal.status === "revoked", JSON.stringify(rv));
  const g2 = await A.get("/grants?project=grantstest");
  ok("revoked grant disappears from /grants", (g2.grants || []).length === 0, JSON.stringify(g2.grants));
  const refile = await A.post("/propose", { session: S2, project: "grantstest", ...KB, key: "patrol.reap-orphans" });
  ok("revocation leaves NO denial memory (a refined re-propose is allowed)", refile.ok === true && refile.proposal.status === "pending", JSON.stringify(refile));
} catch (e) {
  fail++; console.log(`  ✗ hub A block threw: ${e.message}\n${errA.slice(-500)}`);
} finally {
  try { hubA.kill(); } catch {}
  try { rmSync(dirA, { recursive: true, force: true }); } catch {}
}

// ── Hub B (enforce mode): deciding is the OWNER's act — agents cannot approve themselves ─────────
const PB = 47942;
const hubB = spawnHub(PB, { extraEnv: { RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu" } });
let errB = ""; hubB.stderr.on("data", d => errB += d);
await sleep(800);
try {
  const base = `http://127.0.0.1:${PB}`;
  const { generate, signRequest } = await import("./lib/identity.mjs");
  const signHdr = (id, method, path, body) => signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method, path, body });
  const sFetch = async (id, method, path, bodyObj) => {
    const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...signHdr(id, method, path, body) }, body });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const owner = generate(), agent = generate(), rival = generate();
  await sFetch(owner, "POST", "/enroll", { name: "sasha", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  await sFetch(agent, "POST", "/enroll", { name: "aria:govtest", kind: "agent", scopes: [{ project: "govtest", role: "write" }] });
  await sFetch(rival, "POST", "/enroll", { name: "rival:govtest", kind: "agent", scopes: [{ project: "govtest", role: "write" }] });

  console.log("\n[9] enforce: signed filing binds session to signer:");
  const spoof = await sFetch(agent, "POST", "/propose", { session: "rival:govtest", project: "govtest", ...BOUND(9) });
  ok("session != signer -> 403", spoof.status === 403, `got ${spoof.status}`);
  const filed = await sFetch(agent, "POST", "/propose", { session: "aria:govtest", project: "govtest", ...BOUND(9) });
  ok("signed agent files pending", filed.ok === true && filed.proposal?.status === "pending", JSON.stringify(filed));

  console.log("\n[10] enforce: only the owner decides; only the proposer withdraws:");
  const agentDecide = await sFetch(agent, "POST", "/proposal/decide", { id: filed.proposal.id, status: "approved" });
  ok("agent cannot approve (even itself) -> 403", agentDecide.status === 403, `got ${agentDecide.status}`);
  const rivalWithdraw = await sFetch(rival, "POST", "/proposal/withdraw", { id: filed.proposal.id });
  ok("another agent cannot withdraw -> 403", rivalWithdraw.status === 403, `got ${rivalWithdraw.status}`);
  const ownerDecide = await sFetch(owner, "POST", "/proposal/decide", { id: filed.proposal.id, status: "approved", note: "bounded, fine" });
  ok("owner approves", ownerDecide.ok === true && ownerDecide.proposal.status === "approved", JSON.stringify(ownerDecide));
  ok("decidedBy is the signer, not a self-asserted field", ownerDecide.proposal.decidedBy === "sasha", ownerDecide.proposal.decidedBy);
} catch (e) {
  fail++; console.log(`  ✗ hub B block threw: ${e.message}\n${errB.slice(-500)}`);
} finally {
  try { hubB.kill(); } catch {}
  try { rmSync(hubB._dir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
