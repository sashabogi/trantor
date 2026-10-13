#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkMemory, formatMemoryCheck } from "../lib/memory-pins.mjs";
import { pinMemory, formatMemoryPin } from "../lib/memory-pin-write.mjs";

const usage = "Usage: trantor memory check [--project <dir>] [--json]\n       trantor memory pin <note> | --all [--dry-run] [--project <dir>] [--json]";
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
    all: { type: "boolean" }, "dry-run": { type: "boolean" },
  } });
  if (values.help) {
    console.log(usage);
  } else {
    const [command, note] = positionals;
    let result;
    let format;
    if (command === "check" && positionals.length === 1 && !values.all && !values["dry-run"]) {
      result = checkMemory({ project: values.project });
      format = formatMemoryCheck;
    } else if (command === "pin" && positionals.length <= 2 && Boolean(note) !== Boolean(values.all)) {
      result = pinMemory({ project: values.project, note, all: values.all, dryRun: values["dry-run"] });
      format = formatMemoryPin;
    } else {
      throw new Error(usage);
    }
    const output = values.json ? JSON.stringify(result, null, 2) : format(result);
    if (output) console.log(output);
  }
} catch (error) {
  console.error(`memory: ${error.message}`);
  process.exitCode = 1;
}
