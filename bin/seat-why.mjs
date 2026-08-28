#!/usr/bin/env node
// trantor seat-why <agent> [--json] — explain why a crew seat is (not) working, straight from
// local ~/.agent-bus evidence. No hub needed; works even when the whole fleet is down.
import { seatWhy } from "../lib/seat-why.mjs";
import { resolveProject } from "../lib/project.mjs";

const args = process.argv.slice(2);
const agent = args.find(a => !a.startsWith("--"));
const asJson = args.includes("--json");
const projIdx = args.indexOf("--project");
const project = projIdx !== -1 && args[projIdx + 1]
  ? args[projIdx + 1]
  : process.env.RELAY_PROJECT || resolveProject(process.cwd());

if (!agent) {
  console.error("usage: trantor seat-why <agent> [--json] [--project <name>]");
  process.exit(2);
}

const out = await seatWhy(project, agent);
if (asJson) {
  console.log(JSON.stringify({ agent, project, ...out }, null, 2));
} else {
  console.log(`seat ${agent}:${project} -> ${out.state}`);
  console.log(`why:    ${out.why}`);
  console.log(`advice: ${out.advice}`);
}
