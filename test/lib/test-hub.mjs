// #9832 part 2: ~40 suites spawn hub.mjs and then `await sleep(800)` before the first fetch —
// a boot slower than the sleep under a loaded host fails whichever suite draws the short straw
// (two 10-03 gate runs red on test-notify, test-claims, test-proposals, test-silent-stall, all
// "fetch failed"; per-suite fixes just moved the red). startTestHub is the ONE boot for every
// suite: spawn the hub, then poll GET /health (a public endpoint) every 100ms with a 20s bound,
// throwing with the hub's stderr tail on timeout or early exit. Suites migrated onto it delete
// only their BOOT sleep — sleeps that test timing (TTLs, ladders, debounce) stay.
//
//   const hub = await startTestHub();        // free port (default) — no two suites can collide
//   const hub = await startTestHub({ port: 47941 }); // explicit port still allowed
//   ... fetch(hub.base + "/inbox") ...
//   await hub.stop();          // kills the proc, waits for exit, removes the dir it created
//
// #9832 part 3: `port` is now OPTIONAL. Default binds a net server to port 0, reads the
// assigned port, closes it and passes that to the hub — a free port per hub, so parallel
// suites (test/run.mjs concurrency 6) can never collide on a shared literal again.
//
// `stderr` is live (a getter): whatever the hub prints after boot is still accumulated, so a
// catch block can print the tail of a hub that died mid-suite. `dir` is the hub's data dir —
// pass one to reuse it across a restart; stop() only removes dirs it created itself.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

// Bind :0, read what the OS handed us, release. Tiny TOCTOU window between close and the
// hub's bind is the standard price; suites start hubs seconds apart, collisions are vanishingly
// rare compared with the old shared 4xxxx literals that colliding lanes hit every release run.
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => (port ? resolve(port) : reject(new Error("freePort: OS assigned no port"))));
    });
  });
}

export async function startTestHub({ port, env = {}, dir = null } = {}) {
  if (!port) port = await freePort();
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
