#!/usr/bin/env node
// #8723 bounce-4 — peerKindOf is the row's OWN kind, nothing else, behind BOTH /peers and
// declaredCrewFor. Bounce-3's identity fallback was wrong: every enrolled identity defaults kind
// "agent", so every peer went crew and test-discovery's real intruder was never warned about.
// A kindless row is an intruder even when enrolled "agent" — beat stamping keeps rows stamped.
import { createOverseer } from "../../hub/overseer.mjs";
import { setTimeout as sleep } from "node:timers/promises";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
console.log("\n# test-kind-resolver — the row's own kind is the only answer (#8723 bounce-4)");

// Post-restart state, the way it looks when every client stamps its beats: loaded rows carry
// the kind pg COALESCE kept. No identity is consulted anywhere in the crew decision.
const state = {
  peers: {
    "host:x": { project: "x", kind: "orch", pubkey: "PK-orch", lastSeen: Date.now(), _on: true },
    "glm:x":  { project: "x", kind: "agent", pubkey: "PK-agent", lastSeen: Date.now(), _on: true },
    "kimi:x": { project: "x", kind: "agent", pubkey: "PK-agent2", lastSeen: Date.now(), _on: true },
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

ok("peerKindOf: the row's own kind, verbatim",
  o.peerKindOf({ kind: "agent" }) === "agent" && o.peerKindOf({ kind: "orch" }) === "orch");
ok("peerKindOf: a kindless row is kindless even with an enrolled agent identity by pubkey",
  o.peerKindOf({ kind: "", pubkey: "PK-agent" }) === "",
  `got ${JSON.stringify(o.peerKindOf({ kind: "", pubkey: "PK-agent" }))}`);
ok("peerKindOf: no kind and no identity stays kindless",
  o.peerKindOf({ kind: "", pubkey: "" }) === "" && o.peerKindOf(undefined) === "");

// Stamped rows are crew; an UNSTAMPED row with an enrolled agent identity is NOT (the discovery red).
const crew = o.declaredCrewFor("x");
ok("declaredCrewFor: stamped agent/orch rows are crew",
  crew.includes("host:x") && crew.includes("glm:x") && crew.includes("kimi:x"),
  `got ${JSON.stringify(crew)}`);

// The stamped crew alone: the boot tick stays silent, and stays silent.
o.overseerTick();
ok("boot tick on the stamped crew sends nothing to duty", sends.length === 0, JSON.stringify(sends).slice(0, 200));
ok("boot tick logs no overseer.warn", warns.length === 0, JSON.stringify(warns).slice(0, 200));
o.overseerTick();
ok("a further tick stays silent (crew-only is dropped, never an episode)", sends.length === 0 && warns.length === 0);

// Discrimination control, the bounce-3 regression: an unstamped row whose identity IS enrolled
// "agent" is still an intruder, alongside a plain stranger. One warn, then the episode holds.
state.peers["enrolled:x"] = { project: "x", kind: "", pubkey: "PK-agent", lastSeen: Date.now(), _on: true };
state.peers["stranger:x"] = { project: "x", kind: "", pubkey: "", lastSeen: Date.now(), _on: true };
ok("declaredCrewFor still excludes the unstamped row despite its enrolled agent identity",
  !o.declaredCrewFor("x").includes("enrolled:x"),
  `got ${JSON.stringify(o.declaredCrewFor("x"))}`);
o.overseerTick();
ok("an unstamped but enrolled row warns like any intruder",
  warns.length === 1 && (warns[0].sessions || []).includes("enrolled:x") && (warns[0].sessions || []).includes("stranger:x"),
  JSON.stringify(warns).slice(0, 200));
ok("duty hears the warning once", sends.filter(s => s.to === "claude:duty" && /OVERSEER/.test(s.text)).length === 1,
  JSON.stringify(sends).slice(0, 300));
o.overseerTick();
ok("the intruder episode holds: no second warn", warns.length === 1, JSON.stringify(warns).slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
