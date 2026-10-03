// #9832 part 2: ~40 suites spawn hub.mjs and then `await sleep(800)` before the first fetch —
// a boot slower than the sleep under a loaded host fails whichever suite draws the short straw
// (two 10-03 gate runs red on test-notify, test-claims, test-proposals, test-silent-stall, all
// "fetch failed"; per-suite fixes just moved the red). startTestHub is the ONE boot for every
// suite: spawn the hub, then poll GET /health (a public endpoint) every 100ms with a 20s bound,
// throwing with the hub's stderr tail on timeout or early exit. Suites migrated onto it delete
// only their BOOT sleep — sleeps that test timing (TTLs, ladders, debounce) stay.
//
//   const hub = await startTestHub({ port: 47941 });
//   ... fetch(hub.base + "/inbox") ...
//   await hub.stop();          // kills the proc, waits for exit, removes the dir it created
//
// `stderr` is live (a getter): whatever the hub prints after boot is still accumulated, so a
// catch block can print the tail of a hub that died mid-suite. `dir` is the hub's data dir —
// pass one to reuse it across a restart; stop() only removes dirs it created itself.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

export async function startTestHub({ port, env = {}, dir = null } = {}) {
  if (!port) throw new Error("startTestHub: port is required");
  const ownsDir = !dir;
  const d = dir || mkdtempSync(join(tmpdir(), "trantor-hub-"));
  mkdirSync(join(d, ".agent-bus"), { recursive: true });
  const proc = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: d, HOME: d, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrBuf = "";
  proc.stderr.on("data", (x) => (stderrBuf += String(x)));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`test hub exited before accepting requests:\n${stderrBuf.slice(-500)}`);
    try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch {}
    if (Date.now() - t0 > 20000) throw new Error(`test hub not accepting requests after 20s:\n${stderrBuf.slice(-500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = async () => {
    try { proc.kill(); } catch {}
    for (let i = 0; proc.exitCode === null && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
    if (ownsDir) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  };
  return { base, proc, stop, dir: d, get stderr() { return stderrBuf; } };
}
