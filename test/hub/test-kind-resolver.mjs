#!/usr/bin/env node
// #8723 bounce-3 — ONE kind resolver for a peer, used by BOTH /peers and declaredCrewFor.
// Simulates the live restart: peer rows loaded kindless with the identities state loaded — the
// boot tick must judge the set crew-only and send NOTHING (red against the pre-fix code, which
// read declaredCrewFor off p.kind alone and counted the crew as intruders).
import { createOverseer } from "../../hub/overseer.mjs";
import { setTimeout as sleep } from "node:timers/promises";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
console.log("\n# test-kind-resolver — one answer to 'what is this peer' (#8723 bounce-3)");

// Simulated post-restart state: rows exactly as the store loads them — kind "", pubkey kept,
// no per-request identity. Identities survive the restart and carry the enrolled kind.
// Crew-only, the way the incident project looked at boot: seats + orchestrator, all kindless.
const state = {
  peers: {
    "host:x": { project: "x", kind: "", pubkey: "PK-orch", lastSeen: Date.now(), _on: true },
    "glm:x":  { project: "x", kind: "", pubkey: "PK-agent", lastSeen: Date.now(), _on: true },
    "kimi:x": { project: "x", kind: "", pubkey: "PK-agent2", lastSeen: Date.now(), _on: true },
  },
  identities: {
    "PK-orch":   { name: "host", kind: "orch", pubkey: "PK-orch" },
    "PK-agent":  { name: "glm", kind: "agent", pubkey: "PK-agent" },
    "PK-agent2": { name: "kimi", kind: "agent", pubkey: "PK-agent2" },
  },
  tasks: [], orgPolicy: {},
};
const sends = [], warns = [];
const duty = { session: "claude:duty", hubSend: (to, text, project) => sends.push({ to, text, project }) };
const o = createOverseer({
  state, fileClaims: new Map(), now: () => Date.now(),
  appendEvent: (type, project, from, extra) => { if (type === "overseer.warn") warns.push({ type, project, ...extra }); },
  markDirty: () => {}, duty,
});
// The engine + the same-project rule load by dynamic import; the tick is a no-op until they land.
for (let i = 0; i < 100 && (!o.engine || !o.sameProject); i++) await sleep(20);
ok("the overseer engine and the same-project rule loaded", !!o.engine && !!o.sameProject);

// Resolver contract, standalone rows: own kind, else the enrolled identity's kind by pubkey.
ok("peerKindOf: own kind wins", o.peerKindOf({ kind: "agent", pubkey: "PK-orch" }) === "agent");
ok("peerKindOf: kindless row falls back to the enrolled identity by pubkey",
  o.peerKindOf({ kind: "", pubkey: "PK-agent" }) === "agent" && o.peerKindOf({ kind: "", pubkey: "PK-orch" }) === "orch");
ok("peerKindOf: no kind and no identity stays kindless", o.peerKindOf({ kind: "", pubkey: "" }) === "");
state.identities["PK-gone"] = { name: "gone", kind: "agent", pubkey: "PK-gone", revoked: true };
ok("peerKindOf: a revoked identity confers no kind", o.peerKindOf({ kind: "", pubkey: "PK-gone" }) === "",
  `got ${JSON.stringify(o.peerKindOf({ kind: "", pubkey: "PK-gone" }))}`);

// THE contract case: after the simulated restart, declaredCrewFor resolves the kindless rows
// through their identities.
const crew = o.declaredCrewFor("x");
ok("declaredCrewFor resolves the kindless rows through their identities",
  crew.includes("host:x") && crew.includes("glm:x") && crew.includes("kimi:x"),
  `got ${JSON.stringify(crew)}`);

// The boot tick itself: crew-only set -> no warn, nothing sent. Red against the pre-fix code.
o.overseerTick();
ok("boot tick on the restart state sends nothing to duty", sends.length === 0, JSON.stringify(sends).slice(0, 200));
ok("boot tick logs no overseer.warn", warns.length === 0, JSON.stringify(warns).slice(0, 200));
o.overseerTick();
ok("a further tick stays silent (crew-only is dropped, never an episode)", sends.length === 0 && warns.length === 0);

// Discrimination control: an unenrolled stranger + a revoked-identity peer are the intruders.
// One warn; the crew is inside the reported live set but only intruders make it fire.
state.peers["stranger:x"] = { project: "x", kind: "", pubkey: "", lastSeen: Date.now(), _on: true };
state.peers["revoked:x"] = { project: "x", kind: "", pubkey: "PK-gone", lastSeen: Date.now(), _on: true };
o.overseerTick();
ok("the intruder set fires exactly one warn",
  warns.length === 1 && (warns[0].sessions || []).includes("stranger:x") && (warns[0].sessions || []).includes("revoked:x"),
  JSON.stringify(warns).slice(0, 200));
ok("duty hears the warning once", sends.filter(s => s.to === "claude:duty" && /OVERSEER/.test(s.text)).length === 1,
  JSON.stringify(sends).slice(0, 300));
o.overseerTick();
ok("the stranger episode holds: no second warn", warns.length === 1, JSON.stringify(warns).slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
