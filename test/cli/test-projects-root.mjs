#!/usr/bin/env node
// #14306 regression: the CLI finds projects in the folder the desktop app's Settings chose
// ("projectsRoot" in <bus>/config.json). Lookup order is TRANTOR_DEV_ROOT, then that setting, then
// ~/development; a relative or unreadable setting falls through to the default. Pure helpers with an
// injected env, so this process never touches the real HOME or bus.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devRootFor, checkoutFor, localCheckoutFor } from "../../lib/project.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  cond ? pass++ : fail++;
};

const scratch = mkdtempSync(join(tmpdir(), "trantor-projects-root-"));
try {
  const home = join(scratch, "home");
  const bus = join(home, ".agent-bus");
  const chosen = join(scratch, "Code");          // a folder outside ~/development
  const override = join(scratch, "override");
  mkdirSync(bus, { recursive: true });
  mkdirSync(join(chosen, "julians-app"), { recursive: true });
  const env = (extra = {}) => ({ HOME: home, AGENT_BUS_DIR: bus, ...extra });
  const config = (obj) => writeFileSync(join(bus, "config.json"), typeof obj === "string" ? obj : JSON.stringify(obj));

  // no config at all → the convention
  ok("no config falls back to ~/development", devRootFor(env()) === join(home, "development"), devRootFor(env()));

  // the Settings folder
  config({ url: "http://127.0.0.1:4477", projectsRoot: chosen });
  ok("the Settings projects folder is used", devRootFor(env()) === chosen, devRootFor(env()));
  ok("a project under the Settings folder is found", checkoutFor("julians-app", env()) === join(chosen, "julians-app"),
    checkoutFor("julians-app", env()));
  ok("localCheckoutFor finds it from outside any checkout",
    localCheckoutFor("julians-app", scratch, env()) === join(chosen, "julians-app"),
    localCheckoutFor("julians-app", scratch, env()));

  // the env override still wins over the setting
  ok("TRANTOR_DEV_ROOT beats the setting", devRootFor(env({ TRANTOR_DEV_ROOT: override })) === override);

  // AGENT_BUS_DIR unset → reads <HOME>/.agent-bus/config.json
  ok("the default bus dir under HOME is read", devRootFor({ HOME: home }) === chosen, devRootFor({ HOME: home }));

  // a setting the CLI cannot trust falls through
  config({ projectsRoot: "relative/path" });
  ok("a relative setting is ignored", devRootFor(env()) === join(home, "development"), devRootFor(env()));
  config({ projectsRoot: 42 });
  ok("a non-string setting is ignored", devRootFor(env()) === join(home, "development"));
  config("{ not json");
  ok("an unreadable config falls through", devRootFor(env()) === join(home, "development"));

  // an outside edit is seen on the next call, nothing is cached for the process lifetime
  config({ projectsRoot: chosen });
  ok("an edit to the config is picked up", devRootFor(env()) === chosen);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
