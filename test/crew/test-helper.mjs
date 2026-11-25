// #14264: fake herdr proves project isolation and lifecycle without touching a live terminal.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertHerdrIsolated } from "../lib/herdr-stub.mjs";
import { helperCommand } from "../../bin/helper.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "trantor-helper-"));
const fakebin = join(dir, "bin");
mkdirSync(fakebin);
const log = join(dir, "calls.jsonl");
const stateDir = join(dir, "bus");
mkdirSync(stateDir);
const state = join(stateDir, "crew-windows.txt");
const env = { PATH: `${fakebin}:/usr/bin:/bin`, HOME: dir, AGENT_BUS_DIR: stateDir, HERDR_SOCKET_PATH: join(dir, "fake.sock"), LOG: log };
assertHerdrIsolated(env, "helper");
const stub = join(fakebin, "herdr");
writeFileSync(stub, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.LOG, JSON.stringify(args) + '\\n');
if (args[2] === 'dead' || (process.env.FAIL_CLOSE && args[1] === 'close') || (process.env.FAIL_RUN && args[1] === 'run')) process.exit(1);
if (args[1] === 'report-agent' && !['idle', 'working', 'blocked', 'unknown'].includes(args[args.indexOf('--state') + 1])) process.exit(2);
let result = {};
if (args[0] === 'workspace' && args[1] === 'list') result = {workspaces: []};
if (args[0] === 'workspace' && args[1] === 'create') result = {workspace: {workspace_id: 'w-new'}, root_pane: {pane_id: 'w-new:root'}};
if (args[0] === 'pane' && args[1] === 'list') result = {panes: [{workspace_id:'w-project',pane_id:'w-project:orch',cwd:process.env.HOME}, {workspace_id:'w-other',pane_id:'w-other:focused'}]};
if (args[0] === 'pane' && args[1] === 'split') result = {pane: {pane_id:'w-project:helper'}};
console.log(JSON.stringify({result}));
`);
chmodSync(stub, 0o755);
// #14264: a short fake sleep bounds cleanup if a child forks while the test stops its process group.
writeFileSync(join(fakebin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.1\n");
chmodSync(join(fakebin, "sleep"), 0o755);
const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const run = (args, extra = {}) => spawnSync(process.execPath, [join(root, "bin/cli.mjs"), "helper", ...args], { cwd: root, encoding: "utf8", env: { ...env, ...extra } });
let passed = 0;
const ok = (label, fn) => { fn(); console.log(`ok ${++passed} - ${label}`); };
const seed = () => {
  writeFileSync(log, "");
  writeFileSync(state, "p\therdrws\t__ws__\tw-project\nother\therdrws\t__ws__\tw-other\np\therdr\tcodex\tw-project:crew\n");
};
try {
  ok("run records the helper and splits the project's pane with explicit cwd", () => {
    seed();
    const r = run(["run", "--project", "p", "--label", "review code", "--cwd", dir, "--", "printf", "%s", "a 'quoted' $(value)"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "w-project:helper");
    assert.match(readFileSync(state, "utf8"), /p\thelper\treview code\tw-project:helper\thelper\t/);
    assert.deepEqual(calls().find(a => a[1] === "split"), ["pane", "split", "w-project:orch", "--direction", "right", "--no-focus", "--cwd", dir]);
    assert.ok(!calls().some(a => a.includes("w-other:focused")));
    assert.ok(calls().find(a => a[1] === "run")[3].includes("helper finished, exit"));
  });
  ok("run reuses the project orchestrator even without a workspace row", () => {
    writeFileSync(state, "p\torch\t__orch__\tw-project:orch\nother\therdrws\t__ws__\tw-other\n");
    writeFileSync(log, "");
    const r = run(["run", "--project", "p", "--label", "check", "--", "true"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls().find(a => a[1] === "split")[2], "w-project:orch");
    assert.ok(!calls().some(a => a[1] === "create"));
  });
  ok("run creates and records a project workspace if none exists", () => {
    writeFileSync(state, ""); writeFileSync(log, "");
    const r = run(["run", "--project", "new", "--label", "check", "--cwd", dir, "--", "true"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls().find(a => a[1] === "create"), ["workspace", "create", "--cwd", dir, "--label", "trantor:new", "--no-focus"]);
    assert.equal(calls().find(a => a[1] === "split")[2], "w-new:root");
    assert.match(readFileSync(state, "utf8"), /new\therdrws\t__ws__\tw-new/);
  });
  ok("list prunes missing project helpers and preserves other rows", () => {
    seed();
    const rows = "p\thelper\tcheck\tlive\thelper\n";
    writeFileSync(state, readFileSync(state, "utf8") + rows + "p\thelper\told\tdead\thelper\nother\thelper\told\tdead\thelper\n");
    const r = run(["list", "--project", "p"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "live\tcheck");
    assert.ok(!readFileSync(state, "utf8").includes("p\thelper\told"));
    assert.match(readFileSync(state, "utf8"), /other\thelper\told/);
    assert.match(readFileSync(state, "utf8"), /p\therdr\tcodex/);
  });
  ok("stop closes only the named helper and removes its row", () => {
    const r = run(["stop", "live", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true });
    assert.deepEqual(calls().filter(a => a[1] === "close"), [["pane", "close", "live"]]);
    assert.ok(!readFileSync(state, "utf8").includes("\tlive\t"));
    assert.notEqual(run(["stop", "w-project:crew"]).status, 0);
  });
  ok("failed stop preserves tracking and failed launch cleans up", () => {
    seed();
    writeFileSync(state, readFileSync(state, "utf8") + "p\thelper\tcheck\tlive\thelper\n");
    assert.notEqual(run(["stop", "live"], { FAIL_CLOSE: "1" }).status, 0);
    assert.match(readFileSync(state, "utf8"), /\tlive\thelper/);
    assert.notEqual(run(["run", "--project", "p", "--label", "bad", "--", "true"], { FAIL_RUN: "1" }).status, 0);
    assert.ok(!readFileSync(state, "utf8").includes("\tbad\t"));
  });
  ok("missing herdr runs attached with cwd, literal arguments and the command's exit code", () => {
    const r = run(["run", "--project", "p", "--label", "fallback", "--cwd", dir, "--", "/bin/sh", "-c", 'pwd; printf "%s\\n" "$1"; exit 7', "helper", "$(not-a-command)"], { PATH: "" });
    assert.equal(r.status, 7);
    assert.ok(r.stdout.includes(dir));
    assert.ok(r.stdout.includes("$(not-a-command)"));
    assert.match(r.stderr, /Helpers need herdr to show in the app/);
  });
  ok("invalid metadata cannot inject state rows", () => {
    assert.notEqual(run(["run", "--project", "p", "--label", "bad\nrow", "--", "true"]).status, 0);
  });
  const command = helperCommand("live", ["/bin/sh", "-c", 'printf "%s\\n" "$1"; exit 9', "helper", "literal ' $(value)"], env);
  const child = spawn("/bin/sh", ["-c", command], { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let output = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("helper did not finish")), 5000);
      child.stdout.on("data", data => {
        output += data;
        if (output.includes("helper finished, exit 9")) { clearTimeout(timer); resolve(); }
      });
      child.on("error", error => { clearTimeout(timer); reject(error); });
    });
    assert.ok(output.includes("literal ' $(value)"));
    assert.equal(child.exitCode, null);
    assert.ok(calls().some(a => a[1] === "report-agent" && a.includes("idle")));
    console.log(`ok ${++passed} - finished helper preserves output, exit code and its open pane`);
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve));
    process.kill(-child.pid, "SIGKILL");
    await exited;
  }
  console.log(`${passed} helper checks passed`);
} finally { rmSync(dir, { recursive: true, force: true }); }
