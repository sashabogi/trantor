import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { gitCheckoutRoot } from "./git-checkout.mjs";

const SLOW = "pin check skipped (slow), run trantor memory check";

export function memoryStartLine(project) {
  return new Promise(resolveLine => {
    let worker;
    let settled = false;
    const finish = line => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveLine(line);
      if (worker) void worker.terminate().catch(() => {});
    };
    // Keep synchronous graph parsing and file reads off the hook's deadline timer.
    const timer = setTimeout(() => finish(SLOW), 500);
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { project } });
      worker.once("message", finish);
      worker.once("error", () => finish(""));
      worker.once("exit", () => finish(""));
    } catch { finish(""); }
  });
}

async function cachedMemoryLine(directory) {
  const project = gitCheckoutRoot(directory) || resolve(directory);
  const graphPath = join(project, "graft/.graph/wiring.json");
  if (!existsSync(graphPath)) return "";
  const { checkPin, memoryDirectory, notePins } = await import("../../lib/memory-pins.mjs");
  const memoryDir = memoryDirectory(project);
  if (!existsSync(memoryDir)) return "";
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const stale = new Set(), broken = new Set();
  const notes = readdirSync(memoryDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md");
  for (const note of notes) {
    try {
      const pins = notePins(readFileSync(join(memoryDir, note.name), "utf8"));
      for (const pin of pins) {
        const { status } = checkPin(pin, project, nodes);
        if (status === "stale") stale.add(note.name);
        if (status === "broken") broken.add(note.name);
      }
    } catch { /* A concurrent edit or invalid span must not suppress other notes. */ }
  }
  const names = [...new Set([...stale, ...broken])].sort().map(name => name.replace(/[\s\x00-\x1f\x7f]+/g, " "));
  return names.length ? `${stale.size} stale, ${broken.size} broken notes: ${names.join(", ")}; run trantor memory check` : "";
}

if (!isMainThread) {
  try { parentPort.postMessage(await cachedMemoryLine(workerData.project)); }
  catch { parentPort.postMessage(""); }
}
