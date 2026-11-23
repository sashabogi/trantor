#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "trantor-timeout-receipt-"));
const port = await new Promise(resolve => {
  const server = createServer((req, res) => {
    if (req.url === "/enroll") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
    if (req.url.startsWith("/_op?")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"unknown"}'); return; }
    if (req.url === "/write") return;
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
});
try {
  process.env.AGENT_BUS_DIR = dir;
  process.env.HOME = dir;
  process.env.RELAY_URL = `http://127.0.0.1:${port.port}`;
  process.env.RELAY_SESSION = "receipt-test:trantor";
  process.env.RELAY_PROJECT = "trantor";
  const { signedPost } = await import(pathToFileURL(join(process.cwd(), "hooks/lib/api.mjs")));
  const result = await signedPost("/write", { _op: "op-receipt-1" }, { timeoutMs: 25, project: "trantor" });
  const rows = readFileSync(join(dir, "hub-timeouts.jsonl"), "utf8").trim().split("\n");
  const row = JSON.parse(rows[0]);
  const ok = result.ambiguous && rows.length === 1 && row.op === "op-receipt-1" && row.route === "/write"
    && row.elapsedMs >= 20 && row.hubUrl === `http://127.0.0.1:${port.port}`;
  console.log(`  ${ok ? "✓" : "✗"} an ambiguous timed out write appends exactly one receipt row`);
  if (!ok) process.exitCode = 1;
} finally {
  port.server.close();
  rmSync(dir, { recursive: true, force: true });
}
