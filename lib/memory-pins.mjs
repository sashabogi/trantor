import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isMap, parseDocument } from "yaml";
import { z } from "zod";

export function fingerprint(text) {
  const normalized = text.replace(/\r\n/g, "\n").split("\n")
    .map(line => line.trimEnd()).join("\n").replace(/^\n+|\n+$/g, "");
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}

export function memoryDirectory(project, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")) {
  return join(configDir, "projects", resolve(project).replace(/[^a-zA-Z0-9]/g, "-"), "memory");
}

export function frontMatter(text) {
  const match = /^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m.exec(text);
  if (!match || match.index !== 0) {
    if (/^---\r?\n/.test(text)) throw new Error("unterminated front matter");
    return null;
  }
  const document = parseDocument(match[2]);
  if (document.errors.length) throw new Error(`invalid front matter: ${document.errors[0].message.split("\n")[0]}`);
  if (document.contents && !isMap(document.contents)) throw new Error("front matter must be a mapping");
  return { document, yaml: match[2], start: match[1].length, end: match[0].length };
}

export function notePins(text) {
  try {
    const front = frontMatter(text);
    const data = front?.document.toJS();
    if (!data || data.pins == null) return [];
    return Array.isArray(data.pins) ? data.pins : [data.pins];
  } catch (error) {
    return [{ invalid: error.message.split("\n")[0] }];
  }
}

const fileSchema = z.string().min(1).refine(file => !isAbsolute(file)
  && !file.split(/[\\/]/).some(part => part === ".." || part === "" || part === "."));
const symbolSchema = z.object({
  symbol: z.string().refine(symbol => {
    const split = symbol.lastIndexOf("#");
    return split > 0 && split < symbol.length - 1 && fileSchema.safeParse(symbol.slice(0, split)).success;
  }),
  fp: z.string().regex(/^sha256:[0-9a-f]{16}$/),
}).passthrough().refine(pin => !Object.hasOwn(pin, "file"));
const pinSchema = z.union([
  symbolSchema,
  z.object({ file: fileSchema }).passthrough()
    .refine(pin => !Object.hasOwn(pin, "symbol") && !Object.hasOwn(pin, "fp")),
]);

export function pinTarget(pin) {
  const parsed = pinSchema.safeParse(pin);
  if (!parsed.success) return null;
  const value = parsed.data;
  return value.symbol ? { file: value.symbol.slice(0, value.symbol.lastIndexOf("#")), symbol: value.symbol }
    : { file: value.file };
}

export function checkPin(pin, project, nodes) {
  try { return checkTarget(pin, project, nodes); }
  catch (error) { return { pin, status: "invalid pin", detail: error.message }; }
}

function checkTarget(pin, project, nodes) {
  const target = pinTarget(pin);
  if (!target) return { pin, status: "invalid pin", detail: pin?.invalid || "expected symbol + fp, or file without fp" };
  const path = join(project, target.file);
  if (!existsSync(path) || !statSync(path).isFile()) return { pin, status: "broken", detail: `file gone: ${target.file}` };
  if (!target.symbol) return { pin, status: "ok" };
  const node = nodes.get(target.symbol);
  if (!node) return { pin, status: "broken", detail: `symbol gone: ${target.symbol}` };
  const actual = symbolFingerprint(project, node);
  return actual === pin.fp ? { pin, status: "ok" }
    : { pin, status: "stale", actual, detail: `body changed: ${target.symbol} (${pin.fp} -> ${actual})` };
}

export function symbolFingerprint(project, node) {
  const span = /^L(\d+)-L(\d+)$/.exec(node.span);
  const lines = readFileSync(join(project, node.path), "utf8").replace(/\r\n/g, "\n").split("\n");
  if (!span || +span[1] < 1 || +span[2] < +span[1] || +span[2] > lines.length) {
    throw new Error(`invalid graft span for ${node.id}; run graft build`);
  }
  return fingerprint(lines.slice(+span[1] - 1, +span[2]).join("\n"));
}

export function pinFileNewer(project, pin, graphTime) {
  const target = pinTarget(pin);
  if (!target) return false;
  try { return statSync(join(project, target.file)).mtimeMs > graphTime; }
  catch { return false; }
}

export function refreshPinGraph(project, pins = []) {
  const graphPath = join(project, "graft", ".graph", "wiring.json");
  if (!existsSync(graphPath)) return null;
  const needsBuild = () => pins.some(pin => pinFileNewer(project, pin, statSync(graphPath).mtimeMs));
  if (needsBuild()) {
    const lockPath = `${graphPath}.lock`;
    const deadline = Date.now() + 125000;
    let lock;
    while (lock === undefined) {
      try { lock = openSync(lockPath, "wx"); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("timed out waiting for graft build lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    try {
      // Another note writer may have refreshed the graph while we waited.
      if (needsBuild()) {
        const build = spawnSync("graft", ["build", project, "--no-gitignore", "--no-ignore"], {
          encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
        });
        if (build.error || build.status !== 0) throw new Error(`graft build failed: ${build.error?.message || build.stderr || build.stdout}`);
      }
    } finally { closeSync(lock); unlinkSync(lockPath); }
  }
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  if (!Array.isArray(graph.nodes)) throw new Error("invalid graft wiring graph: missing nodes");
  return new Map(graph.nodes.map(node => [node.id, node]));
}

export function checkMemory({ project = process.cwd(), memoryDir = memoryDirectory(project) } = {}) {
  project = resolve(project);
  const graphPath = join(project, "graft", ".graph", "wiring.json");
  if (!existsSync(graphPath)) return { project, status: "pins off", message: "no graft graph, pins off", notes: [] };
  const notes = existsSync(memoryDir) ? readdirSync(memoryDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md")
    .map(entry => ({ name: entry.name, pins: notePins(readFileSync(join(memoryDir, entry.name), "utf8")) })) : [];
  let nodes = new Map();
  if (notes.some(note => note.pins.some(pin => pinTarget(pin)?.symbol))) {
    try { nodes = refreshPinGraph(project, notes.flatMap(note => note.pins)); }
    catch (error) { return { project, status: "pins off", message: `pins off: ${error.message}`, notes: [] }; }
  }
  return { project, status: "checked", notes: notes.map(note => ({
    name: note.name, pins: note.pins.map(pin => checkPin(pin, project, nodes)),
  })) };
}

export function formatMemoryCheck(result) {
  if (result.message) return result.message;
  return result.notes.flatMap(note => note.pins.filter(pin => pin.status !== "ok")
    .map(pin => `${note.name}: ${pin.status} — ${pin.detail}`)).join("\n") || `ok: ${result.notes.length} notes, ${result.notes.reduce((sum, note) => sum + note.pins.length, 0)} pins`;
}
