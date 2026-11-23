import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertHerdrIsolated, herdrSocketFor, realHerdrSocket, writeStubHerdr } from "../lib/herdr-stub.mjs";

// #13922: every herdr-touching test resolves a STUB herdr and fails closed on the real socket;
// crew closes aimed at the caller's own workspace/pane are refused. All herdr calls here go to
// the PATH stub under this suite's temp dir — the live server is never contacted.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const out = join(ROOT, ".agent-bus-out");
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(out, "herdr-isolation-"));
const fakebin = join(dir, "fakebin");
writeStubHerdr(fakebin);
const stubSocket = join(dir, "stub-herdr.sock");
let passed = 0;
const ok = (label, fn) => { fn(); passed += 1; console.log(`ok ${passed} - ${label}`); };
const childEnv = (extra = {}) => ({ PATH: `${fakebin}:/usr/bin:/bin`, HOME: dir, HERDR_SOCKET_PATH: stubSocket, ...extra });
const runChild = (script, env) => {
  const logFile = join(dir, `herdr-${Math.random().toString(36).slice(2)}.log`);
  const child = { ...env, HERDR_STUB_LOG: logFile };
  assertHerdrIsolated(child, "child drill");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, join(ROOT, "bin/crew/herdr.mjs")], {
    cwd: ROOT, encoding: "utf8", env: child,
  });
  const log = (() => { try { return readFileSync(logFile, "utf8"); } catch { return ""; } })();
  return { log, stdout: result.stdout, stderr: result.stderr, status: result.status };
};

try {
  ok("herdrSocketFor honors HERDR_SOCKET_PATH, then falls back to HOME", () => {
    assert.equal(herdrSocketFor({ HERDR_SOCKET_PATH: "/tmp/alt.sock", HOME: "/home/a" }), "/tmp/alt.sock");
    assert.equal(herdrSocketFor({ HOME: "/home/a" }), join("/home/a", ".config", "herdr", "herdr.sock"));
  });

  ok("the fail-closed guard trips when the env would resolve the REAL socket", () => {
    const real = realHerdrSocket();
    assert.ok(real, "realHerdrSocket resolves a path");
    assert.throws(() => assertHerdrIsolated({ HERDR_SOCKET_PATH: real }, "real"), /REAL socket/);
    const saved = process.env.TRANTOR_TEST_HERDR_REAL_SOCK;
    process.env.TRANTOR_TEST_HERDR_REAL_SOCK = join(dir, "home1", ".config", "herdr", "herdr.sock");
    try {
      assert.throws(() => assertHerdrIsolated({ HOME: join(dir, "home1") }, "real via HOME"), /REAL socket/);
    } finally {
      if (saved === undefined) delete process.env.TRANTOR_TEST_HERDR_REAL_SOCK; else process.env.TRANTOR_TEST_HERDR_REAL_SOCK = saved;
    }
  });

  ok("the fail-closed guard trips through a symlink alias of the real socket", () => {
    const real = join(dir, "fixture-real.sock");
    writeFileSync(real, "");
    const alias = join(dir, "fixture-alias.sock");
    symlinkSync(real, alias);
    const saved = process.env.TRANTOR_TEST_HERDR_REAL_SOCK;
    process.env.TRANTOR_TEST_HERDR_REAL_SOCK = real;
    try {
      assert.throws(() => assertHerdrIsolated({ HERDR_SOCKET_PATH: alias }, "alias"), /REAL socket/);
    } finally {
      if (saved === undefined) delete process.env.TRANTOR_TEST_HERDR_REAL_SOCK; else process.env.TRANTOR_TEST_HERDR_REAL_SOCK = saved;
    }
  });

  ok("the fail-closed guard passes a stub env and names its socket", () => {
    const env = childEnv();
    assert.equal(assertHerdrIsolated(env, "stub"), stubSocket);
  });

  ok("closing the caller's OWN workspace is refused before any herdr call", () => {
    const r = runChild(`
      import { pathToFileURL } from "node:url";
      const mod = await import(pathToFileURL(process.argv[1]));
      process.stdout.write(\`closed=\${mod.closeWorkspace({ dry: false, env: process.env }, "WS-OWN")}\`);
    `, childEnv({ HERDR_WORKSPACE_ID: "WS-OWN", HERDR_PANE_ID: "WS-OWN:P-9" }));
    assert.match(r.stdout, /closed=false/);
    assert.match(r.stderr, /refusing to close herdr workspace WS-OWN/);
    assert.match(r.stderr, /TRANTOR_CLOSE_OWN_WORKSPACE=1/);
    assert.ok(!r.log.includes("workspace close WS-OWN"), "no close reached herdr");
  });

  ok("a pane id alone still names the caller's home (embedded workspace prefix)", () => {
    const r = runChild(`
      import { pathToFileURL } from "node:url";
      const mod = await import(pathToFileURL(process.argv[1]));
      process.stdout.write(\`closed=\${mod.closeWorkspace({ dry: false, env: process.env }, "WS-OWN")}\`);
    `, childEnv({ HERDR_PANE_ID: "WS-OWN:P-9" }));
    assert.match(r.stdout, /closed=false/);
    assert.ok(!r.log.includes("workspace close WS-OWN"));
  });

  ok("TRANTOR_CLOSE_OWN_WORKSPACE=1 lets an operator close their own workspace", () => {
    const r = runChild(`
      import { pathToFileURL } from "node:url";
      const mod = await import(pathToFileURL(process.argv[1]));
      process.stdout.write(\`closed=\${mod.closeWorkspace({ dry: false, env: process.env }, "WS-OWN")}\`);
    `, childEnv({ HERDR_WORKSPACE_ID: "WS-OWN", TRANTOR_CLOSE_OWN_WORKSPACE: "1" }));
    assert.match(r.stdout, /closed=true/);
    assert.ok(r.log.includes("herdr workspace close WS-OWN"));
  });

  ok("closing the caller's OWN pane is refused; a sibling pane in the same workspace is not", () => {
    const r = runChild(`
      import { pathToFileURL } from "node:url";
      const mod = await import(pathToFileURL(process.argv[1]));
      const own = mod.closePane({ dry: false, env: process.env }, "WS-OWN:P-ME");
      const sibling = mod.closePane({ dry: false, env: process.env }, "WS-OWN:P-SIB");
      process.stdout.write(\`own=\${own} sibling=\${sibling}\`);
    `, childEnv({ HERDR_WORKSPACE_ID: "WS-OWN", HERDR_PANE_ID: "WS-OWN:P-ME" }));
    assert.match(r.stdout, /own=false sibling=true/);
    assert.match(r.stderr, /refusing to close herdr pane WS-OWN:P-ME/);
    assert.ok(!r.log.includes("pane close WS-OWN:P-ME"));
    assert.ok(r.log.includes("herdr pane close WS-OWN:P-SIB"));
  });

  const spawnScript = `
    import { pathToFileURL } from "node:url";
    const { spawnHerdr } = await import(pathToFileURL(process.argv[1]));
    const ctx = { dry: false, project: "testproj", dir: process.env.SPAWN_DIR, statePath: process.env.SPAWN_STATE, have: { herdr: true }, env: process.env };
    try { spawnHerdr(ctx, ["codex"], agent => ({ agent, model: "" }), () => {}); }
    catch (error) { process.stderr.write(\`THREW \${error.message}\\n\`); }
  `;
  const live = { HERDR_LIVE_WS: '{"workspace_id":"WS-NEW","label":"trantor:testproj"}' };

  ok("stale-stacked cleanup still closes a truly stale workspace against the stub", () => {
    const state = join(dir, "state-close.txt");
    const spawnDir = join(dir, "proj");
    mkdirSync(spawnDir, { recursive: true });
    writeFileSync(state, "testproj\therdrws\t__ws__\tWS-OLD\ntestproj\therdrws\t__ws__\tWS-NEW\n");
    const r = runChild(spawnScript, childEnv({ ...live, HERDR_WORKSPACE_ID: "WS-OTHER", HERDR_LIVE_PANES: JSON.stringify({ pane_id: "P-HOST", workspace_id: "WS-NEW", cwd: spawnDir }), SPAWN_STATE: state, SPAWN_DIR: spawnDir }));
    assert.ok(r.log.includes("herdr workspace close WS-OLD"), `stale close reached the stub: ${r.log}`);
    assert.ok(!readFileSync(state, "utf8").includes("WS-OLD"), "the closed stale row is dropped");
    assert.ok(readFileSync(state, "utf8").includes("WS-NEW"), "the reused row survives");
  });

  ok("stale-stacked cleanup refuses the caller's OWN workspace and keeps its row", () => {
    const state = join(dir, "state-refuse.txt");
    const spawnDir = join(dir, "proj");
    mkdirSync(spawnDir, { recursive: true });
    writeFileSync(state, "testproj\therdrws\t__ws__\tWS-OLD\ntestproj\therdrws\t__ws__\tWS-NEW\n");
    const r = runChild(spawnScript, childEnv({ ...live, HERDR_WORKSPACE_ID: "WS-OLD", HERDR_LIVE_PANES: JSON.stringify({ pane_id: "P-HOST", workspace_id: "WS-NEW", cwd: spawnDir }), SPAWN_STATE: state, SPAWN_DIR: spawnDir }));
    assert.ok(!r.log.includes("workspace close WS-OLD"), "no close of the caller's home reached herdr");
    assert.match(r.stderr, /refusing to close herdr workspace WS-OLD/);
    const after = readFileSync(state, "utf8");
    assert.ok(after.includes("WS-OLD"), "the refused row stays: the workspace is still live");
    assert.ok(after.includes("WS-NEW"));
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed`);
