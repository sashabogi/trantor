import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { codexRelayFlags } from "../../bin/crew/codex-relay.mjs";

const runner = readFileSync(new URL("../../bin/crew-runner.mjs", import.meta.url), "utf8");
const templates = [...runner.matchAll(/`(codex exec[^`]+)`/g)].map(match => match[1]);
assert.equal(templates.length, 2);
assert.match(runner, /codexRelayFlags\(\{ persona: PERSONA, session: SESSION, project: PROJ, hub: HUB \}\)/);
let checks = 0;
for (const persona of ["codex", "codex-4", "codex-5", "reviewer-2"]) {
  for (const template of templates) {
    const project = "trantor";
    const session = `${persona}:${project}`;
    const hub = "http://127.0.0.1:4477/path?literal='$(false)'";
    const command = template.replaceAll("{M}", "").replaceAll("{R}", () => codexRelayFlags({ persona, session, project, hub }));
    // Capture the actual shell argv; no CLI, model call, hub, or global config is needed.
    const probe = `codex() { ${process.execPath} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"; }; ${command.replace('"$(cat {P})"', '"contract"')}`;
    const run = spawnSync("/bin/bash", ["-c", probe], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const args = JSON.parse(run.stdout);
    const env = { RELAY_AGENT: "codex", RELAY_SESSION: "codex:wrong", RELAY_PROJECT: "wrong", RELAY_URL: "http://wrong", KEEP: "untouched" };
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "-c") continue;
      const setting = args[++i];
      const at = setting.indexOf("=");
      env[setting.slice(0, at).replace("mcp_servers.relay.env.", "")] = JSON.parse(setting.slice(at + 1));
    }
    assert.deepEqual(env, { RELAY_AGENT: persona, RELAY_SESSION: session, RELAY_PROJECT: project, RELAY_URL: hub, KEEP: "untouched" });
    assert.equal(args.at(-1), "contract");
    checks++;
  }
}
console.log(`codex relay identity: ${checks} fresh/resume cases passed`);
