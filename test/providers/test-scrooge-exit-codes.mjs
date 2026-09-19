#!/usr/bin/env node
// #6893 — scrooge's exit-code contract against a FAKE provider (real engine/bin/scrooge, fake HTTP):
// 429/400/404 must exit 2 with ONE ✗ stderr line naming status+model+flattened body; empty-200 exits
// 0 with byte-empty stdout + an "empty answer" note; any failed assert exits this runner 1. The fake
// provider is a CHILD printing "PORT=<n>" — spawnSync blocks this loop, so in-process deadlocked.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCROOGE = join(ROOT, "engine", "bin", "scrooge");
let fail = 0;
const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };

// The fake OpenAI-compatible provider: the prompt's marker picks the response. A 429 body carries
// RAW NEWLINES to pin the one-line stderr contract (#6893). The model field is ignored on purpose —
// responses key off the prompt marker, not off how scrooge spells the model on the wire.
if (process.argv.includes("--fake-provider")) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let prompt = "";
      try { prompt = (JSON.parse(raw).messages || [{}]).map((m) => m.content || "").join("\n"); } catch {}
      const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(body); };
      if (prompt.includes("status429")) json(429, JSON.stringify({ error: { message: "rate limited\nsecond line\nthird line", type: "test" } }));
      else if (prompt.includes("status400")) json(400, JSON.stringify({ error: { message: "bad request\nsecond line\nthird line", type: "test" } }));
      else if (prompt.includes("status404")) json(404, JSON.stringify({ error: { message: "no such model\nsecond line\nthird line", type: "test" } }));
      else if (prompt.includes("empty200")) json(200, JSON.stringify({ choices: [] }));
      else json(200, JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    });
  });
  server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
  setTimeout(() => process.exit(1), 60000); // orphan guard: die even if the parent vanished
  process.on("SIGTERM", () => process.exit(0));
} else {
  await main();
}

async function main() {
  const provider = spawn(process.execPath, [import.meta.filename, "--fake-provider"],
    { stdio: ["ignore", "pipe", "inherit"] });
  let bootError = null;
  const port = await new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => { bootError = new Error("no PORT= readiness line in 10s"); resolve(null); }, 10000);
    provider.stdout.on("data", (c) => {
      buf += c;
      const m = buf.match(/^PORT=(\d+)/m);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    provider.on("exit", (code) => { clearTimeout(timer); bootError = new Error("exited early (code " + code + ")"); resolve(null); });
  });

  const HOME = mkdtempSync(join(tmpdir(), "trantor-scrooge-exit-"));
  try {
    if (port === null) {
      ok(false, "fake provider booted: " + bootError.message);
    } else {
      writeFileSync(join(HOME, "registry.json"), JSON.stringify({
        providers: { fakeprov: { base_url: `http://127.0.0.1:${port}/v1`, env: ["FAKE_API_KEY"] } },
        models: { "fakeprov/fake-model-1": { provider: "fakeprov", cost_in: 0.1, cost_out: 0.2 } },
        aliases: {}, tasks: {},
        orchestrator: { name: "Opus", cost_in: 15.0, cost_out: 75.0 },
      }, null, 2));
      console.log(`# scrooge exit-code tests (fake provider on 127.0.0.1:${port})`);

      // Positive control: the fake provider actually serves BEFORE any scrooge spawn — a zero-yield
      // probe must never be trusted without one.
      try {
        const ctl = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "ready-probe" }] }),
        });
        const body = await ctl.json();
        ok(ctl.status === 200 && body.choices?.[0]?.message?.content === "pong",
          "fake provider serves a round-trip before any scrooge spawn");
      } catch (e) {
        ok(false, "fake provider serves a round-trip before any scrooge spawn (" + e.message + ")");
      }

      const run = (prompt) => spawnSync("python3", [SCROOGE, "-m", "fakeprov/fake-model-1", prompt], {
        input: "",
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, SCROOGE_HOME: HOME, FAKE_API_KEY: "test-key", SCROOGE_NO_PREVIEW: "1" },
      });
      // A killed child reports status null — that is a FAILURE, never a pass (the old
      // `status !== 0` read null as non-zero).
      const expectExit = (r, want, label) => {
        ok(Number.isInteger(r.status), `${label}: exit is a real integer, never null (got ${r.status}${r.signal ? `, killed by ${r.signal}` : ""})`);
        ok(r.status === want, `${label}: exits ${want} (got ${r.status})`);
      };
      const xLines = (r) => (r.stderr || "").split("\n").filter((l) => l.includes("✗"));

      // Positive control on the happy path: a real answer exits 0 and carries the text on stdout.
      const good = run("happy path");
      expectExit(good, 0, "happy path");
      ok(good.stdout === "pong\n", `happy path stdout is the answer (got ${JSON.stringify(good.stdout)})`);
      ok(!(good.stderr || "").includes("empty answer"), "happy path has no empty-answer note");

      // Hard provider errors: exit 2, stdout empty, ONE stderr line with status + model + flattened body.
      for (const code of [429, 400, 404]) {
        const r = run(`status${code}`);
        expectExit(r, 2, `HTTP ${code}`);
        ok(r.stdout === "", `HTTP ${code} stdout stays empty (got ${JSON.stringify(r.stdout)})`);
        const lines = xLines(r);
        ok(lines.length === 1, `HTTP ${code} is exactly one ✗ stderr line (got ${lines.length})`);
        ok(lines[0]?.includes(`HTTP ${code}`) ?? false, `HTTP ${code} named on the ✗ line`);
        ok(lines[0]?.includes("fake-model-1") ?? false, `model named on the HTTP ${code} ✗ line`);
        ok(lines[0]?.includes("third line") ?? false, `HTTP ${code} body flattened onto the one line`);
      }

      // Empty 200: success (exit 0), stdout truly byte-empty, stderr says "empty answer".
      const empty = run("empty200");
      expectExit(empty, 0, "empty answer");
      ok(empty.stdout === "", `empty answer stdout is truly empty (got ${JSON.stringify(empty.stdout)})`);
      ok((empty.stderr || "").includes("empty answer"), "empty answer noted on stderr");
    }
  } finally {
    provider.kill("SIGTERM");
    rmSync(HOME, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
}
