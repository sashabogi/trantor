#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pinMemory } from "../lib/memory-pin-write.mjs";
import { memoryDirectory } from "../lib/memory-pins.mjs";
import { gitCheckoutRoot } from "./lib/git-checkout.mjs";

async function pinSavedNote() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (!["Write", "Edit"].includes(input.tool_name) || !input.cwd || !input.tool_input?.file_path) return;
  const path = resolve(input.cwd, input.tool_input.file_path);
  if (!path.endsWith(".md") || basename(path) === "MEMORY.md") return;
  const memoryRoot = dirname(dirname(memoryDirectory(input.cwd)));
  if (!path.startsWith(`${memoryRoot}/`) || basename(dirname(path)) !== "memory") return;
  const project = gitCheckoutRoot(input.cwd) || resolve(input.cwd);
  const memoryDir = memoryDirectory(project);
  if (dirname(path) !== memoryDir) return;
  // A symlink must not turn a note-save hook into a write outside project memory.
  if (dirname(realpathSync(path)) !== realpathSync(memoryDir)) return;
  const result = pinMemory({ project, memoryDir, note: basename(path) });
  if (result.message) console.error(`memory-pin: ${result.message}`);
  for (const note of result.notes) {
    for (const diagnostic of note.diagnostics) console.error(`memory-pin: ${note.name}: ${diagnostic}`);
  }
}

try { await pinSavedNote(); }
catch (error) { console.error(`memory-pin: ${error.message}`); }
