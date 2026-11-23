// #13970: `trantor restore` existed in bin/crew.mjs but bin/cli.mjs never routed it, so the
// command printed the general help instead of running. The CLI must hand restore to crew.mjs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../bin/cli.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tt-restore-route-"));
mkdirSync(join(home, ".agent-bus"), { recursive: true });
const r = spawnSync(process.execPath, [cli, "restore", "--dry-run"], {
  env: { ...process.env, HOME: home, AGENT_BUS_DIR: join(home, ".agent-bus"), PATH: process.env.PATH },
  encoding: "utf8", timeout: 30000,
});
const out = `${r.stdout}\n${r.stderr}`;
let failed = 0;
const ok = (name, cond, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`); if (!cond) failed++; };
ok("restore is routed, not answered with the general help", !out.includes("Docs: https://github.com/sashabogi/trantor"), out.slice(0, 300));
ok("restore speaks for itself (its own output or its own error)", /restore/i.test(out), out.slice(0, 300));
process.exit(failed ? 1 : 0);
