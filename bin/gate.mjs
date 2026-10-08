#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";
import { resolveProject } from "../lib/project.mjs";
import { relayUrl } from "../hooks/lib/api.mjs";

const [status, rawId] = process.argv.slice(2);
const id = Number(rawId);
if (!["go", "nogo"].includes(status) || !Number.isInteger(id) || id <= 0) {
  console.error("usage: trantor gate go|nogo <id>");
  process.exit(1);
}
let config = {};
try { config = JSON.parse(readFileSync(join(process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), "config.json"), "utf8")); } catch {}
const identity = loadOrCreate(config.ownerIdentity || "admin", "human");
try {
  const project = resolveProject(process.cwd());
  const r = await sfetchJson(`${relayUrl(project)}/hold/decide`, {
    method: "POST", identity, payload: { id, status, project }, signal: AbortSignal.timeout(8000),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || `HTTP ${r.status}`);
  console.log(`#${id}: ${status} — ${result.hold.file}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
