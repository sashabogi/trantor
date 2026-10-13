#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { projectAttribution } from "../lib/attribution.mjs";
import { resolveProject } from "../lib/project.mjs";
import { signedGet } from "../hooks/lib/api.mjs";

try {
  const { values } = parseArgs({ options: { json: { type: "boolean" }, root: { type: "string" }, project: { type: "string" }, ref: { type: "string" }, "cache-dir": { type: "string" } } });
  const root = resolve(values.root || process.cwd());
  const project = values.project || resolveProject(root);
  const result = await projectAttribution({ root, project, ref: values.ref, cacheDir: values["cache-dir"], loadCards: async () => {
    const response = await signedGet(`/tasks?project=${encodeURIComponent(project)}&fields=slim`, { project, timeoutMs: 15000 });
    if (!response.ok || !Array.isArray(response.json?.tasks)) throw new Error("Attribution unavailable: could not read card assignees from the hub");
    return new Map(response.json.tasks.map(card => [card.id, card.assignee]));
  } });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
