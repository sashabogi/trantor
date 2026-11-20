import "../isolate-bus.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadOrCreate } from "../../lib/identity.mjs";
import { down } from "../../bin/crew/state.mjs";
import { verifyCrew } from "../../bin/crew/verify.mjs";

const dir = mkdtempSync(join(tmpdir(), "crew-owner-"));
const bus = join(dir, "bus");
mkdirSync(bus, { recursive: true });
const owner = loadOrCreate("netcup-crew", "human");
loadOrCreate("host:fixture", "agent");
writeFileSync(join(bus, "config.json"), JSON.stringify({ ownerIdentity: owner.name, url: "http://hub.example" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.headers?.["x-trantor-pubkey"], owner.pubkey, `unexpected signer at ${url}`);
    if (String(url).endsWith("/keys/usage")) return new Response('{"ok":true}', { status: 200 });
    if (String(url).endsWith("/enroll")) return new Response('{"ok":true}', { status: 200 });
    return new Response('{"ok":true,"removed":true}', { status: 200, headers: { "content-type": "application/json" } });
  };
try {
  const child = await import("node:child_process");
  const ctx = { root: resolve("."), project: "fixture", hub: "http://hub.example", env: { ...process.env, HOME: dir, AGENT_BUS_DIR: bus, TRANTOR_NO_KEYCHAIN: "1", RELAY_URL: "http://hub.example", RELAY_PROJECT: "fixture" } };
  // Verify's subprocess inherits the configured owner identity environment from the isolated config.
  // Run its CLI independently with a fake fetch is not possible, so assert its implementation path
  // directly in a spawned script that replaces fetch before dynamically importing the CLI module.
  const script = `
    import { loadOrCreate } from ${JSON.stringify(new URL("../../lib/identity.mjs", import.meta.url).href)};
    const owner=loadOrCreate("netcup-crew","human");
    globalThis.fetch=async (url,options={})=>{ if(options.headers?.["x-trantor-pubkey"]!==owner.pubkey) process.exit(12); return new Response(url.endsWith("/keys/usage")?'{"ok":true}':'{"peers":[]}',{status:200,headers:{"content-type":"application/json"}}); };
    process.argv=[process.execPath,"crew-verify.mjs","fixture","codex","--timeout","1"];
    await import(${JSON.stringify(new URL("../../bin/crew-verify.mjs", import.meta.url).href)});
  `;
  // Verify directly in process without allowing its process.exit to affect this suite: test helper
  // checks exact signer by launching an isolated Node child with the same configured bus.
  const verifyChild = child.spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ctx.root, env: ctx.env, encoding: "utf8" });
  assert.equal(verifyChild.status, 1, verifyChild.stderr);
  assert.match(verifyChild.stdout, /FAILED:codex/);

  const downCtx = { project: "fixture", hub: "http://hub.example", home: dir, statePath: join(dir, "crew-windows.txt"), env: { CREW_NO_PROC_KILL: "1" }, dry: false };
  writeFileSync(downCtx.statePath, "fixture\ttmux\tcodex\twindow\n");
  const adapters = { herdr: { closePane() {}, closeWorkspace() {} }, cmux: { closePane() {}, closeWorkspace() {} } };
  await down(downCtx, ["codex"], adapters, { removeWorktree: async () => ({ status: "missing" }), processes: () => [] });
} finally {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
}
console.log("owner identity paths passed");
