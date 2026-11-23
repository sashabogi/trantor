import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { symlinkSync } from "node:fs";
import { axeDoctorStatus } from "../../lib/sim/axe-status.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BIN = join(ROOT, "bin", "sim.mjs");
const here = mkdtempSync(join(tmpdir(), "trantor-sim-test-"));
const fakeBin = join(here, "bin");
const noAxeBin = join(here, "no-axe-bin");
const statePath = join(here, "devices.json");
const registryPath = join(here, "registry.json");
const callsPath = join(here, "calls.jsonl");
const appPath = join(here, "Trantor.app");
mkdirSync(fakeBin, { recursive: true }); mkdirSync(noAxeBin); mkdirSync(appPath);

const initialDevices = () => ({ devices: { "iOS 27.0": [
  { name: "iPhone 17", udid: "SIM-A", state: "Shutdown" },
  { name: "iPad mini", udid: "SIM-B", state: "Shutdown" },
] } });
writeFileSync(statePath, JSON.stringify(initialDevices()));
writeFileSync(callsPath, "");

const writeBin = (name, source) => writeFileSync(join(fakeBin, name), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
writeBin("xcrun", `
import fs from "node:fs";
const state = JSON.parse(fs.readFileSync(process.env.SIMCTL_STATE, "utf8"));
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.SIMCTL_CALLS, JSON.stringify(entry) + "\\n");
if (args.join(" ") === "simctl list devices --json") process.stdout.write(JSON.stringify(state));
else if (args[0] === "simctl" && args[1] === "boot") { state.devices["iOS 27.0"].find(d => d.udid === args[2]).state = "Booted"; fs.writeFileSync(process.env.SIMCTL_STATE, JSON.stringify(state)); log(args); }
else if (args[0] === "simctl" && args[1] === "shutdown") { state.devices["iOS 27.0"].find(d => d.udid === args[2]).state = "Shutdown"; fs.writeFileSync(process.env.SIMCTL_STATE, JSON.stringify(state)); log(args); }
else if (args[0] === "simctl" && args[1] === "io" && args[3] === "screenshot") { fs.writeFileSync(args[4], "png"); log(args); }
else { log(args); if (args[1] === "launch") process.stdout.write("com.example.app: 1234\\n"); }
`);
writeBin("axe", `
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SIMCTL_CALLS, JSON.stringify(["axe", ...args]) + "\\n");
if (args[0] === "--version") process.stdout.write("2.1.1\\n");
else if (args[0] === "describe-ui") process.stdout.write(JSON.stringify([{ role: "Application", frame: { x: 0, y: 0, width: 390, height: 844 }, children: [
  { role: "Group", frame: { x: 0, y: 0, width: 390, height: 844 } },
  { role: "Group", frame: { x: 12, y: 22, width: 0, height: 0 } },
  { role: "Slider", role_description: "scroll bar", frame: { x: 380, y: 0, width: 10, height: 844 } },
  { role: "Group", frame: { x: 8, y: 60, width: 100, height: 30 } },
  { AXLabel: "Full screen labeled row", role: "Group", frame: { x: 0, y: 0, width: 390, height: 844 } },
  { AXUniqueId: "empty-but-addressable", role: "Group", frame: { x: 12, y: 22, width: 0, height: 0 } },
  { AXLabel: "Continue", AXUniqueId: "continue-button", role_description: "button", enabled: true, frame: { x: 20, y: 730, width: 350, height: 50 } }
] }]));
else if (process.env.FAIL_AXE) { process.stderr.write("synthetic AXe failure\\n"); process.exit(4); }
`);
writeBin("sips", `
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "-g") process.stdout.write("/tmp/screen.png\\n  pixelWidth: 1170\\n  pixelHeight: 2532\\n");
else fs.copyFileSync(args[3], args[5]);
`);
symlinkSync(join(fakeBin, "xcrun"), join(noAxeBin, "xcrun"));
symlinkSync(join(fakeBin, "sips"), join(noAxeBin, "sips"));

const env = (extra = {}) => ({ ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, SIMCTL_STATE: statePath,
  SIMCTL_CALLS: callsPath, TRANTOR_SIM_REGISTRY: registryPath, TRANTOR_SIM_OUTPUT: join(here, "shots"),
  RELAY_SESSION: "codex-7:trantor", ...extra });
const run = (args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, env: env(extra), encoding: "utf8" });
const calls = () => readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
let checks = 0;
function ok(name, value, detail = "") {
  checks++;
  if (!value) { console.error(`✗ ${name}${detail ? `: ${detail}` : ""}`); process.exitCode = 1; }
  else console.log(`✓ ${name}`);
}

try {
  let r = run(["boot", "iPhone 17"]);
  if (r.status !== 0) throw new Error(`boot failed (status ${r.status}): ${r.error?.message || r.stderr}`);
  let j = JSON.parse(r.stdout);
  ok("boot emits JSON and waits for simulator readiness", r.status === 0 && j.udid === "SIM-A" && j.state === "Booted"
    && calls().some((call) => call[1] === "bootstatus"));

  let state = JSON.parse(readFileSync(statePath, "utf8"));
  state.devices["iOS 27.0"][1].state = "Booted";
  writeFileSync(statePath, JSON.stringify(state));
  r = run(["boot", "iPhone 17"]);
  ok("boot refuses a different already-booted simulator", r.status !== 0 && /another simulator is already booted/.test(r.stderr));
  state.devices["iOS 27.0"][1].state = "Shutdown";
  writeFileSync(statePath, JSON.stringify(state));

  r = run(["install", appPath]);
  ok("install targets the owned simulator", r.status === 0 && JSON.parse(r.stdout).udid === "SIM-A"
    && calls().some((call) => call[1] === "install" && call[2] === "SIM-A"));
  r = run(["launch", "com.example.app"]);
  ok("launch returns simulator and bundle metadata", r.status === 0 && JSON.parse(r.stdout).bundle === "com.example.app");

  r = run(["screen"]);
  j = JSON.parse(r.stdout);
  ok("screen returns point-space bounds, labeled tree, and screenshot evidence", r.status === 0
    && j.dimensionsPoints.width === 390 && j.dimensionsPoints.height === 844
    && j.elements.some((item) => item.label === "Continue" && item.id === "continue-button" && item.role === "button" && item.enabled)
    && existsSync(j.screenshot) && calls().some((call) => call[0] === "axe" && call[1] === "describe-ui"));
  ok("screen trims unlabeled full-screen, zero-size, and scroll-bar nodes while retaining addressable nodes", j.elements.length === 4
    && j.elements.some((item) => item.role === "Group" && item.frame.width === 100)
    && j.elements.some((item) => item.label === "Full screen labeled row")
    && j.elements.some((item) => item.id === "empty-but-addressable")
    && !j.elements.some((item) => item.role === "scroll bar" || item.role === "Slider"));

  r = run(["tap", "--label", "Continue"]);
  ok("tap supports labels", r.status === 0 && calls().some((call) => call[1] === "tap" && call.includes("--label") && call.includes("Continue")));
  r = run(["tap", "--id", "continue-button"]);
  ok("tap supports identifiers", r.status === 0 && calls().some((call) => call[1] === "tap" && call.includes("--id") && call.includes("continue-button")));
  r = run(["tap", "--xy", "10,20"]);
  ok("tap supports point coordinates", r.status === 0 && calls().some((call) => call[1] === "tap" && call.includes("-x") && call.includes("10")));
  let before = calls().filter((call) => call[0] === "axe" && call[1] === "tap").length;
  r = run(["tap", "--xy", "9999,9999"]);
  ok("tap rejects coordinates outside the screen without driving AXe", r.status !== 0 && /outside the simulator screen \(390x844 points\)/.test(r.stderr)
    && calls().filter((call) => call[0] === "axe" && call[1] === "tap").length === before);
  const cached = JSON.parse(readFileSync(registryPath, "utf8"));
  delete cached.owners[Object.keys(cached.owners)[0]].dimensionsPoints;
  writeFileSync(registryPath, JSON.stringify(cached));
  before = calls().filter((call) => call[0] === "axe" && call[1] === "describe-ui").length;
  r = run(["tap", "--xy", "10,20"]);
  const recached = JSON.parse(readFileSync(registryPath, "utf8"));
  ok("coordinate tap reads and caches dimensions when screen has not been read", r.status === 0
    && calls().filter((call) => call[0] === "axe" && call[1] === "describe-ui").length === before + 1
    && recached.owners[Object.keys(recached.owners)[0]].dimensionsPoints.width === 390);
  r = run(["swipe", "--from", "10,20", "--to", "100,200"]);
  ok("swipe forwards point-space endpoints", r.status === 0 && calls().some((call) => call[1] === "swipe" && call.includes("--start-x") && call.includes("--end-y")));
  before = calls().filter((call) => call[0] === "axe" && call[1] === "swipe").length;
  r = run(["swipe", "--from", "10,20", "--to", "9999,9999"]);
  ok("swipe rejects either endpoint outside the screen", r.status !== 0 && /--to point 9999,9999 is outside/.test(r.stderr)
    && calls().filter((call) => call[0] === "axe" && call[1] === "swipe").length === before);
  r = run(["type", "hello", "world"]);
  ok("type preserves whitespace-separated input", r.status === 0 && calls().some((call) => call[1] === "type" && call[2] === "hello world"));

  r = run(["screen"], { PATH: noAxeBin });
  ok("missing AXe prints exact installer command without stack trace", r.status !== 0
    && /AXe is missing\. Install the pinned release with: bash .*bin\/install-axe\.sh/.test(r.stderr)
    && !/at .*sim\.mjs/.test(r.stderr));

  r = run(["shutdown"]);
  j = JSON.parse(r.stdout);
  ok("shutdown stops and unregisters the owned simulator", r.status === 0 && j.shutdown && j.udid === "SIM-A");
  r = run(["shutdown"]);
  ok("shutdown is idempotent when no simulator is owned", r.status === 0 && JSON.parse(r.stdout).shutdown === false);

  ok("doctor skips the AXe host probe off macOS", axeDoctorStatus("linux", false).kind === "note");
  ok("doctor reports the exact AXe pin on macOS", axeDoctorStatus("darwin", true, "2.1.1").kind === "ok");
  ok("doctor warns when a different AXe version is installed", axeDoctorStatus("darwin", true, "2.0.0").kind === "warn");
} finally {
  rmSync(here, { recursive: true, force: true });
}
console.log(`\n${checks} simulator checks`);
if (process.exitCode) process.exit(process.exitCode);
