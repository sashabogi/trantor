// #7414: `trantor app update` relaunches the app from an env with no session identity in it, so the
// app never inherits the badge of the crew pane that ran the update.
import { readFileSync } from "node:fs";
import { cleanLaunchEnv, isIdentityKey } from "../../lib/launch-env.mjs";

let fail = 0; const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };

const badged = {
  PATH: "/fixture/bin", HOME: "/Users/fixture", CLAUDE_AGENT_TEAMS: "feature-not-identity",
  TRANTOR_ORCH: "trantor", TRANTOR_SEAT: "codex",
  RELAY_PROJECT: "trantor", RELAY_SESSION: "claude:trantor", RELAY_AGENT: "claude", RELAY_URL: "http://other.invalid",
  CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "badge", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "2009",
  CLAUDE_SESSION_ID: "s", CLAUDE_PROJECT_DIR: "/wrong",
  HERDR_ENV: "1", HERDR_PANE_ID: "w2R:p1", HERDR_WORKSPACE_ID: "w2R", HERDR_TAB_ID: "t1",
};
const clean = cleanLaunchEnv(badged);
ok(Object.keys(clean).sort().join(",") === "CLAUDE_AGENT_TEAMS,HOME,PATH", `only the non-identity names survive (${Object.keys(clean).join(",")})`);
ok(clean.PATH === "/fixture/bin" && clean.HOME === "/Users/fixture", "surviving values are untouched");
ok(Object.keys(badged).filter(isIdentityKey).length === Object.keys(badged).length - 3, "every badge name in the fixture is an identity key");
ok(!isIdentityKey("CLAUDE_AGENT_TEAMS") && !isIdentityKey("TRANTOR_ROOT"), "a feature flag and the dev-root override are not identity");
ok(cleanLaunchEnv({}).constructor === Object && Object.keys(cleanLaunchEnv({})).length === 0, "an empty env stays empty");

// The Rust side scrubs the same names (desktop/src-tauri/src/identity_env.rs); the two lists drift only on purpose.
const rust = readFileSync(new URL("../../desktop/src-tauri/src/identity_env.rs", import.meta.url), "utf8");
for (const key of ["TRANTOR_ORCH", "TRANTOR_SEAT", "CLAUDECODE", "CLAUDE_PID", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", '"RELAY_"', '"CLAUDE_CODE_"']) {
  ok(rust.includes(key), `identity_env.rs scrubs ${key}`);
}

// app.mjs relaunches through the scrubbed env, never process.env.
const app = readFileSync(new URL("../../bin/app.mjs", import.meta.url), "utf8");
ok(/spawn\("\/usr\/bin\/open", \["-a", APP\], \{ env: cleanLaunchEnv\(\)/.test(app), "trantor app relaunches `open -a Trantor.app` with cleanLaunchEnv()");
ok(/cmd === "update" \|\| wasRunning/.test(app), "update always relaunches; install relaunches only a replaced running app");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
