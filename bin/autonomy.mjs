#!/usr/bin/env node
// `trantor autonomy` — read and set the three dials from the CLI.
//
// The app will grow a settings pane for this, but the CLI has to work on its own: crew.sh asks
// this for the harness dial every time it starts your session, and a headless machine has no app.
import { resolveAutonomy, setAutonomy, loadAutonomy, AUTONOMY_PATH } from "../lib/autonomy.mjs";
import { resolveProject } from "../lib/project.mjs";

const D = "\x1b[2m", B = "\x1b[1m", R = "\x1b[0m";
const args = process.argv.slice(2);
const cmd = args[0] || "show";

function projectFlag() {
  const i = args.indexOf("--project");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  if (args.includes("--global")) return null;
  return resolveProject(process.cwd());
}

const BOOLS = ["commit", "push", "deploy", "swapDeadSeat", "retryFailedTurn"];
const ENUMS = { harness: ["prompt", "bypass"] };

if (cmd === "get") {
  // Machine-readable, one value, no decoration — crew.sh reads this.
  const key = args[1];
  const a = resolveAutonomy(projectFlag() || "");
  if (!(key in a)) { console.error(`unknown dial '${key}'`); process.exit(1); }
  console.log(String(a[key]));
} else if (cmd === "set") {
  const key = args[1];
  let value = args[2];
  const project = projectFlag();
  if (BOOLS.includes(key)) {
    if (!["on", "off", "true", "false"].includes(value)) {
      console.error(`${key} takes on|off`); process.exit(1);
    }
    value = value === "on" || value === "true";
  } else if (ENUMS[key]) {
    if (!ENUMS[key].includes(value)) { console.error(`${key} takes ${ENUMS[key].join("|")}`); process.exit(1); }
  } else {
    console.error(`unknown dial '${key}' — one of: ${[...Object.keys(ENUMS), ...BOOLS].join(", ")}`);
    process.exit(1);
  }
  const out = setAutonomy(project, { [key]: value });
  console.log(`${key} = ${out[key]}${project ? ` for ${project}` : " (default for every project)"}`);
  // The dependencies can quietly refuse what was just asked for, so say when that happened rather
  // than letting the operator believe a dial is on.
  if (key === "push" && value === true && out.push === false) {
    console.log(`${D}push stayed off: it needs commit on first${R}`);
  }
  if (key === "deploy" && value === true && out.deploy === false) {
    console.log(`${D}deploy stayed off: it needs push on first${R}`);
  }
} else if (cmd === "json") {
  // The app reads through THIS, not by parsing autonomy.json itself. The dependency rules (push
  // implies commit, deploy implies push) live in one place, and a second implementation in Rust
  // would drift from it the first time either side changed.
  const project = projectFlag();
  const cfg = loadAutonomy();
  console.log(JSON.stringify({
    project,
    resolved: resolveAutonomy(project || "", cfg),
    defaults: resolveAutonomy("", { ...cfg, projects: {} }),
    overridden: project && cfg.projects?.[project] ? Object.keys(cfg.projects[project]) : [],
    path: AUTONOMY_PATH(),
  }));
} else if (cmd === "show" || cmd === "list") {
  const project = projectFlag();
  const a = resolveAutonomy(project || "");
  const cfg = loadAutonomy();
  const overridden = project && cfg.projects?.[project] ? Object.keys(cfg.projects[project]) : [];
  const mark = k => (overridden.includes(k) ? `${D} (set for ${project})${R}` : "");
  console.log(`${B}autonomy${R}${project ? ` · ${project}` : " · defaults"}`);
  console.log(`\n  ${B}harness${R}    ${a.harness}${mark("harness")}    ${D}whether YOUR claude asks before acting${R}`);
  console.log(`  ${D}what a crew AGENT may do unattended is the overseer's level, per project, on the hub${R}`);
  console.log(`\n  ${D}what Trantor does on your behalf:${R}`);
  for (const k of BOOLS) console.log(`  ${B}${k}${R}${" ".repeat(Math.max(1, 11 - k.length))}${a[k] ? "on" : "off"}${mark(k)}`);
  console.log(`\n${D}${AUTONOMY_PATH()}${R}`);
  console.log(`${D}trantor autonomy set commit on   ·   set harness bypass --global${R}`);
} else {
  console.log("usage: trantor autonomy [show] | get <dial> | set <dial> <value> [--project P | --global]");
  process.exit(1);
}
