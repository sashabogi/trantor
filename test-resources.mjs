#!/usr/bin/env node
// Tests for hooks/lib/resources.mjs (INTERSESSION-OPS-CONTRACT #4214). Stub-based: `cmux`, `ps`
// and `lsof` are SEPARATE stub executables on a prepended PATH (an in-process stub would deadlock
// against spawnSync/execFileSync — the kimi overseer-test lesson). HOME + RELAY_DATA_DIR point at
// a temp tree; the fake process table uses pid numbers that map only through the stub lsof, so
// nothing real is ever probed, killed, or pruned. Run: `node test-resources.mjs` → ALL PASS (n).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fixture tree ──────────────────────────────────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), "trantor-resources-"));
const HOME_DIR = join(TMP, "home");
const BUS = join(TMP, "bus");                       // RELAY_DATA_DIR
const HOME_BUS = join(HOME_DIR, ".agent-bus");      // where crew.sh looks ($HOME/.agent-bus)
const BIN = join(TMP, "bin");                       // stub executables
const PROJ = join(TMP, "projA");
const PROJ2 = join(TMP, "projA2");                  // prefix-sibling: anchoring bait
const OUTSIDE = join(TMP, "outside");
for (const d of [HOME_DIR, BUS, HOME_BUS, BIN, PROJ, PROJ2, OUTSIDE]) mkdirSync(d, { recursive: true });

const LSOF_MAP = join(TMP, "lsof-map.tsv");
const CMUX_JSON = join(TMP, "cmux-out.txt");

process.env.HOME = HOME_DIR;
process.env.RELAY_DATA_DIR = BUS;
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.STUB_LSOF_MAP = LSOF_MAP;
process.env.STUB_CMUX_JSON = CMUX_JSON;
delete process.env.CREW_DRY_RUN;

// ── stub executables (separate processes, never in-process) ───────────────────
const stubs = {
  ps: `#!/bin/bash
if [ "\${1:-}" = "eww" ]; then
  case "\${3:-}" in
    101) echo 'CREW_MODEL=cli-default node /x/trantor/bin/crew-runner.mjs codex ${PROJ}' ;;
    102) echo 'node /x/trantor/bin/crew-runner.mjs glm ${PROJ2}' ;;
  esac
  exit 0
fi
cat <<'PSOUT'
    1 launchd
  101 node /x/trantor/bin/crew-runner.mjs codex ${PROJ}
  102 node /x/trantor/bin/crew-runner.mjs glm ${PROJ2}
  110 node /x/app/node_modules/.bin/vite --port 5173
  111 npm run dev
  112 tail -f /var/log/app.log
  113 node /x/web/node_modules/.bin/next dev
  115 node /x/app/node_modules/.bin/vitest run
  130 grep crew-runner.mjs
  140 node /x/other.js
PSOUT
`,
  lsof: `#!/bin/bash
pid=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then pid="$2"; shift 2; continue; fi
  shift
done
cwd=$(awk -F'\\t' -v p="$pid" '$1==p{print $2; exit}' "$STUB_LSOF_MAP" 2>/dev/null)
if [ -n "$cwd" ]; then printf 'p%s\\nn%s\\n' "$pid" "$cwd"; exit 0; fi
exit 1
`,
  cmux: `#!/bin/bash
[ -n "\${CMUX_STUB_FAIL:-}" ] && exit 1
case "\${1:-}" in
  ping) exit 0 ;;
  workspace) cat "$STUB_CMUX_JSON" ;;
  list-pane-surfaces) echo '{"surfaces":[{"id":"SURF-1"}]}' ;;
  *) exit 1 ;;
esac
exit 0
`,
};
for (const [name, body] of Object.entries(stubs)) {
  const p = join(BIN, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

// Fake pid → cwd map for the lsof stub.
writeFileSync(LSOF_MAP, [
  `110\t${PROJ}`,            // vite, cwd IS the project dir
  `111\t${PROJ}/sub`,        // npm run dev, cwd UNDER the project dir
  `112\t${PROJ2}`,           // tail -f in the prefix-sibling — must NOT match projA
  `113\t${OUTSIDE}`,         // next dev elsewhere
  `115\t${PROJ}`,            // vitest — not a dev server despite the "vite" prefix
  "",
].join("\n"));

// cmux output: notice chatter before the JSON (the real CLI does this), array form.
writeFileSync(CMUX_JSON,
  `cmux: connected to default profile\n` +
  JSON.stringify([
    { id: "WS-1", ref: "workspace:1", custom_title: "trantor:projA", name: "ws1" },
    { id: "WS-2", ref: "workspace:2", name: "plain" },
  ]) + "\n");

// Seeded crew-windows.txt for listCrewRows (RELAY_DATA_DIR).
writeFileSync(join(BUS, "crew-windows.txt"), [
  "projA\tcmux\tcodex\tWS-1",
  "projA\tcmuxws\t__ws__\tWS-2",
  "projB\ttmux\tglm\t%3",
  "legacyagent\t12345",          // legacy v2: AGENT<TAB>WID
  "garbage",                     // 1 field — skipped
  "a\tb\tc",                     // 3 fields — skipped
  "",
].join("\n"));

mkdirSync(join(HOME_DIR, ".config", "opencode"), { recursive: true });
writeFileSync(join(HOME_DIR, ".config", "opencode", "opencode.json"), JSON.stringify({ model: "deepseek/deepseek-v4-flash" }));

// Seeded crew-windows.txt for cleanDead (crew.sh reads $HOME/.agent-bus). cmux kinds only, so the
// prune path is driven entirely by the stub (no real osascript/Terminal probe).
writeFileSync(join(HOME_BUS, "crew-windows.txt"), [
  "projA\tcmux\tcodex\tWS-1",     // live per stub → kept
  "projGone\tcmux\tglm\tDEAD-HANDLE", // no live trantor:projGone workspace → pruned (seat rows are validated at WORKSPACE granularity since the 0.17.63 prune fix)
  "projA\tcmuxws\t__ws__\tWS-2",  // live per stub → kept
  "",
].join("\n"));

const R = await import("./hooks/lib/resources.mjs");

// ── runner ────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log("# resources.mjs — detection library");

await test("listCrewRows parses v3 4-field rows with kinds", () => {
  const rows = R.listCrewRows();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { project: "projA", kind: "cmux", agent: "codex", handle: "WS-1" });
  assert.deepEqual(rows[1], { project: "projA", kind: "cmuxws", agent: "__ws__", handle: "WS-2" });
  assert.deepEqual(rows[2], { project: "projB", kind: "tmux", agent: "glm", handle: "%3" });
});

await test("listCrewRows maps legacy 2-field rows to {project:'',kind:'win'}", () => {
  const legacy = R.listCrewRows().find(r => r.agent === "legacyagent");
  assert.deepEqual(legacy, { project: "", kind: "win", agent: "legacyagent", handle: "12345" });
});

await test("listCrewRows returns [] when the state file is missing", () => {
  const keep = process.env.RELAY_DATA_DIR;
  process.env.RELAY_DATA_DIR = join(TMP, "empty-bus");
  try { assert.deepEqual(R.listCrewRows(), []); }
  finally { process.env.RELAY_DATA_DIR = keep; }
});

await test("liveRunners(null) reports pinned or effective global models and ignores decoys", () => {
  const rs = R.liveRunners(null);
  assert.equal(rs.length, 2);
  assert.deepEqual(rs[0], { pid: 101, agent: "codex", dir: PROJ, model: "cli-default", modelSource: "crew" });
  assert.deepEqual(rs[1], { pid: 102, agent: "glm", dir: PROJ2, model: "deepseek/deepseek-v4-flash", modelSource: "opencode-global" });
});

await test("liveRunners(project) is anchored — projA never matches projA2", () => {
  const rs = R.liveRunners("projA");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].agent, "codex");
  assert.equal(R.liveRunners("projA2").length, 1);
  assert.equal(R.liveRunners("proj").length, 0);          // bare prefix must match nothing
});

await test("liveRunners is fail-silent when ps cannot run", () => {
  const keep = process.env.PATH;
  process.env.PATH = join(TMP, "no-bins");                 // empty dir: ps is ENOENT
  try { assert.deepEqual(R.liveRunners(null), []); }
  finally { process.env.PATH = keep; }
});

await test("cmuxWorkspaces parses id/title through CLI chatter", () => {
  assert.deepEqual(R.cmuxWorkspaces(), [
    { id: "WS-1", title: "trantor:projA" },               // custom_title wins over name
    { id: "WS-2", title: "plain" },
  ]);
});

await test("cmuxWorkspaces returns [] when the socket is off", () => {
  process.env.CMUX_STUB_FAIL = "1";
  try { assert.deepEqual(R.cmuxWorkspaces(), []); }
  finally { delete process.env.CMUX_STUB_FAIL; }
});

await test("devServers finds dev-ish procs whose cwd is under dir, anchored", () => {
  const devs = R.devServers(PROJ);
  assert.deepEqual(devs.map(d => d.pid).sort((a, b) => a - b), [110, 111]);
  assert.ok(!devs.some(d => d.pid === 112), "tail -f in projA2 must not match projA");
  assert.ok(!devs.some(d => d.pid === 113), "next dev outside dir must not match");
  assert.ok(!devs.some(d => d.pid === 115), "vitest is not a dev server");
  assert.ok(devs[0].cmd.length > 0);
});

await test("devServers('') returns []", () => {
  assert.deepEqual(R.devServers(""), []);
});

await test("inventory(project) composes rows/runners/workspaces/devServers", () => {
  const inv = R.inventory("projA");
  assert.equal(inv.rows.length, 4);
  assert.equal(inv.runners.length, 1);
  assert.equal(inv.workspaces.length, 2);
  assert.deepEqual(inv.devServers.map(d => d.pid).sort((a, b) => a - b), [110, 111]);
});

await test("inventory(null) is machine-wide and leaves devServers empty", () => {
  const inv = R.inventory(null);
  assert.equal(inv.runners.length, 2);
  assert.deepEqual(inv.devServers, []);
  assert.equal(inv.workspaces.length, 2);
});

await test("cleanDead prunes only provably-dead tracking rows (crew.sh prune)", () => {
  const out = R.cleanDead("projA");
  assert.match(out, /pruned/);
  const state = readFileSync(join(HOME_BUS, "crew-windows.txt"), "utf8");
  assert.ok(state.includes("WS-1"), "live cmux row kept");
  assert.ok(state.includes("WS-2"), "live cmuxws row kept");
  assert.ok(!state.includes("DEAD-HANDLE"), "dead row pruned");
});

console.log(`\n${fail ? `FAIL (${fail} failed, ${pass} passed)` : `ALL PASS (${pass})`}`);
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
