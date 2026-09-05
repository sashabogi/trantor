#!/usr/bin/env node
// trantor — unit tests for PER-PROJECT hub routing (TDD §12.1, card #3932).
//
// A project lives on exactly ONE hub; codependent projects MUST share one. lib/project.mjs
// resolves the hub as: RELAY_URL env → config.json hubs[project] → legacy global `url` → the
// built-in local default. These tests pin every step of that chain — plus fail-open on a
// corrupt/missing config (hooks run inside the user's tool loop and must NEVER throw).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const dir = mkdtempSync(join(tmpdir(), "trantor-hubrt-"));
process.env.AGENT_BUS_DIR = dir;                 // must be set BEFORE importing the module
delete process.env.RELAY_URL;

const { resolveHub, setProjectHub, unsetProjectHub, readConfig, DEFAULT_HUB_URL } = await import("./lib/project.mjs");
const { relayUrl } = await import("./hooks/lib/api.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); } };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

console.log("\nResolution chain (no config):");
ok("falls back to the built-in local default", resolveHub("crebral") === DEFAULT_HUB_URL, resolveHub("crebral"));

console.log("\nLegacy global `url` (pre-§12.1 installs keep working):");
writeFileSync(join(dir, "config.json"), JSON.stringify({ url: "http://127.0.0.1:9999" }));
ok("global url applies to any project", resolveHub("crebral") === "http://127.0.0.1:9999");
ok("…and to a different project", resolveHub("trantor") === "http://127.0.0.1:9999");

console.log("\nPer-project pin wins over the global url:");
setProjectHub("crebral", "http://10.0.0.5:4477/");
ok("pinned project resolves to its hub (trailing slash stripped)", resolveHub("crebral") === "http://10.0.0.5:4477", resolveHub("crebral"));
ok("unpinned project still uses the global url", resolveHub("trantor") === "http://127.0.0.1:9999");
ok("config holds the hubs map", readConfig().hubs?.crebral === "http://10.0.0.5:4477");

console.log("\nCodependent projects share one hub:");
setProjectHub("crebral-health", "http://10.0.0.5:4477");
ok("second project pins to the same hub", resolveHub("crebral-health") === "http://10.0.0.5:4477");
ok("first pin is untouched", resolveHub("crebral") === "http://10.0.0.5:4477");

console.log("\nRELAY_URL env is the explicit override (tests / crew seats):");
ok("env beats the per-project pin", resolveHub("crebral", { RELAY_URL: "http://override:1" }) === "http://override:1");

console.log("\nUnset:");
ok("unset returns true when a pin existed", unsetProjectHub("crebral") === true);
ok("unpinned project falls back to the global url", resolveHub("crebral") === "http://127.0.0.1:9999");
ok("other pin survives the unset", resolveHub("crebral-health") === "http://10.0.0.5:4477");
ok("unset returns false when no pin existed", unsetProjectHub("crebral") === false);
unsetProjectHub("crebral-health");

console.log("\nValidation:");
{ let threw = false; try { setProjectHub("x", "not-a-url"); } catch { threw = true; } ok("set rejects a non-http(s) url", threw); }
{ let threw = false; try { setProjectHub("", "http://ok:1"); } catch { threw = true; } ok("set rejects an empty project", threw); }

console.log("\nFail-open (hook contract — never throw):");
writeFileSync(join(dir, "config.json"), "{ not json !!!");
ok("corrupt config resolves to the default, no throw", resolveHub("crebral") === DEFAULT_HUB_URL);
writeFileSync(join(dir, "config.json"), JSON.stringify({ hubs: "garbage" }));
ok("non-object hubs map is ignored", resolveHub("crebral") === DEFAULT_HUB_URL);
rmSync(join(dir, "config.json"), { force: true });
ok("missing config resolves to the default", resolveHub("crebral") === DEFAULT_HUB_URL);

console.log("\nhooks/lib/api.mjs relayUrl() follows the same chain:");
writeFileSync(join(dir, "config.json"), JSON.stringify({ url: "http://127.0.0.1:9999", hubs: { trantor: "http://10.0.0.5:4477" } }));
process.env.RELAY_PROJECT = "trantor";
ok("relayUrl resolves this project's pin", relayUrl() === "http://10.0.0.5:4477", relayUrl());
ok("explicit project arg wins", relayUrl("other") === "http://127.0.0.1:9999");
delete process.env.RELAY_PROJECT;
rmSync(join(dir, "config.json"), { force: true });
ok("relayUrl fail-opens to the default with no config", relayUrl() === DEFAULT_HUB_URL);

rmSync(dir, { recursive: true, force: true });

console.log("\nSplit hub long-poll owns and settles its response once:");
const pollDir = mkdtempSync(join(tmpdir(), "trantor-hubpoll-"));
const pollPort = await freePort();
const pollHub = spawn(process.execPath, [fileURLToPath(new URL("./hub.mjs", import.meta.url))], {
  env: {
    ...drillEnv(), HOME: pollDir, RELAY_DATA_DIR: pollDir, RELAY_STORE: "json",
    RELAY_AUTH: "off", RELAY_HOST: "127.0.0.1", RELAY_PORT: String(pollPort),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let pollHubError = "";
pollHub.stderr.on("data", chunk => { pollHubError += chunk; });
try {
  const pollBase = `http://127.0.0.1:${pollPort}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await fetch(`${pollBase}/health`)).ok) break; } catch {}
    await sleep(50);
  }
  const response = await fetch(`${pollBase}/poll?session=drill:routing&since=0&wait=0.001`);
  const payload = await response.json();
  await sleep(400);
  const health = await fetch(`${pollBase}/health`);
  ok("long-poll timer returns one 200 response", response.status === 200 && Array.isArray(payload.messages), `${response.status} ${JSON.stringify(payload)}`);
  ok("timer cannot answer again or crash the hub", health.status === 200 && pollHub.exitCode === null, pollHubError.trim());
} catch (error) {
  ok("long-poll drill completes without a second-response throw", false, `${error.message}; ${pollHubError.trim()}`);
} finally {
  pollHub.kill();
  rmSync(pollDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
