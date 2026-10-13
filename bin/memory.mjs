#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkMemory, formatMemoryCheck } from "../lib/memory-pins.mjs";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: trantor memory check [--project <dir>] [--json]");
  } else {
    if (positionals.length !== 1 || positionals[0] !== "check") throw new Error("Usage: trantor memory check [--project <dir>] [--json]");
    const result = checkMemory({ project: values.project });
    const output = values.json ? JSON.stringify(result, null, 2) : formatMemoryCheck(result);
    if (output) console.log(output);
  }
} catch (error) {
  console.error(`memory check: ${error.message}`);
  process.exitCode = 1;
}
