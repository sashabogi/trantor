// #9832: the ONE hub boot for every suite — spawn hub.mjs, poll GET /health every 100ms (20s
// bound), replacing the per-suite sleep(800) that raced slow boots. Default port binds :0 so
// parallel suites never collide; hub.stop() kills the proc and removes dirs it created itself.
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
    // RELAY_AUTH pinned "off" (not inherited, not the hub default) so non-auth suites keep the
    // old ergonomics under enforce-by-default (#11368); a suite's explicit RELAY_AUTH still wins.
    env: { ...drillEnv(), RELAY_DATA_DIR: d, HOME: d, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", RELAY_AUTH: "off", ...env },
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
