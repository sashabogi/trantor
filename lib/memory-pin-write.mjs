import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { checkPin, frontMatter, memoryDirectory, notePins, pinTarget, refreshPinGraph, symbolFingerprint } from "./memory-pins.mjs";

export function replaceNotePins(text, pins) {
  const front = frontMatter(text);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const value = stringify(pins, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();
  if (!front) return `---${newline}pins: ${value}${newline}---${newline}${text}`;
  const pair = front.document.contents?.items.find(item => item.key?.value === "pins");
  if (!pair) {
    if (front.document.contents?.flow) throw new Error("cannot add pins to flow-style front matter without changing other keys");
    const at = front.start + front.yaml.length;
    return `${text.slice(0, at)}pins: ${value}${newline}${text.slice(at)}`;
  }
  // Value ranges exclude neighboring keys and their comments; never reserialize the whole note.
  const [start, end] = pair.value.range;
  const old = front.yaml.slice(start, end);
  const ending = old.match(/\r?\n$/)?.[0] || "";
  const spacing = start === end ? " " : "";
  return text.slice(0, front.start + start) + spacing + value + ending + text.slice(front.start + end);
}

export function extractMentions(text, project, nodes, siblingNotes = new Set()) {
  const front = frontMatter(text);
  const body = (front ? text.slice(front.end) : text)
    .replace(/\[\[[\s\S]*?\]\]/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  const paths = new Set([...nodes.values()].map(node => node.path));
  const mentions = [];
  const seen = new Set();
  const pattern = /(?<![\w./\\-])((?:\.\/)?(?:[\w@.-]+\/)*[\w@.-]+)(?:#([\w$.-]+)|:(\d+))?/g;
  for (const match of body.matchAll(pattern)) {
    let file = match[1].replace(/^\.\//, "").replace(/[.,]+$/, "");
    if (!pinTarget({ file }) || file === "Node.js") continue;
    if (siblingNotes.has(file)) continue;
    if (!file.includes("/") && /^v?\d+(?:\.[\da-z-]+)+$/i.test(file)
      && !/\.(?:[cm]?jsx?|tsx?|py|rs|go|swift|c|h|cpp|hpp|java|kt|rb|sh|php|vue|svelte)$/i.test(file)) continue;
    const prefix = `${basename(project)}/`;
    if (!existingFile(project, file) && file.startsWith(prefix) && existingFile(project, file.slice(prefix.length))) {
      file = file.slice(prefix.length);
    }
    if (!paths.has(file) && !existingFile(project, file) && !file.includes("/") && !/\.(?:[cm]?jsx?|tsx?|py|rs|go|swift|c|h|cpp|hpp|java|kt|rb|sh|php|vue|svelte|md|mdx|txt|json|ya?ml|toml|sql|css|html)$/i.test(file)) continue;
    const symbol = match[2]?.replace(/\.+$/, "");
    const mention = symbol ? { file, symbol: `${file}#${symbol}` }
      : match[3] ? { file, line: Number(match[3]) } : { file };
    const key = JSON.stringify(mention);
    if (!seen.has(key)) { seen.add(key); mentions.push(mention); }
  }
  return mentions;
}

function existingFile(project, file) {
  return existsSync(join(project, file)) && statSync(join(project, file)).isFile();
}

function resolveMention(mention, nodes, project) {
  if (!existingFile(project, mention.file)) return null;
  if (mention.symbol) return nodes.has(mention.symbol) ? { symbol: mention.symbol, fp: symbolFingerprint(project, nodes.get(mention.symbol)) } : null;
  if (mention.line === undefined) return { file: mention.file };
  const lines = readFileSync(join(project, mention.file), "utf8").split(/\r?\n/);
  if (mention.line < 1 || mention.line > lines.length) return null;
  const enclosing = [...nodes.values()].filter(node => node.path === mention.file && node.kind !== "file")
    .map(node => ({ node, span: /^L(\d+)-L(\d+)$/.exec(node.span) }))
    .filter(({ span }) => span && +span[1] <= mention.line && +span[2] >= mention.line)
    .sort((a, b) => (+a.span[2] - +a.span[1]) - (+b.span[2] - +b.span[1]));
  return enclosing.length ? { symbol: enclosing[0].node.id, fp: symbolFingerprint(project, enclosing[0].node) } : { file: mention.file };
}

function planNote(text, project, nodes, date, siblingNotes) {
  const pins = notePins(text);
  const diagnostics = [];
  const keys = new Set(pins.map(pin => pinTarget(pin)).filter(Boolean).map(pin => pin.symbol || pin.file));
  for (const mention of extractMentions(text, project, nodes, siblingNotes)) {
    if (!existingFile(project, mention.file)) {
      diagnostics.push(`mentions a path that doesn't exist: ${mention.file}`);
      continue;
    }
    const pin = resolveMention(mention, nodes, project);
    if (!pin) { diagnostics.push(`unresolved mention: ${mention.symbol || `${mention.file}:${mention.line}`}`); continue; }
    const key = pin.symbol || pin.file;
    if (!keys.has(key)) { pins.push({ ...pin, at: date }); keys.add(key); }
  }
  const refreshed = pins.map(pin => {
    const checked = checkPin(pin, project, nodes);
    if (checked.status === "broken" || checked.status === "invalid pin") {
      diagnostics.push(`${checked.status}: ${checked.detail}`);
      return pin;
    }
    const refreshed = { ...pin };
    if (checked.actual) { refreshed.fp = checked.actual; refreshed.at = date; }
    return refreshed;
  });
  return { pins: refreshed, diagnostics, text: refreshed.length ? replaceNotePins(text, refreshed) : text };
}

export function pinMemory({ project = process.cwd(), memoryDir = memoryDirectory(project), note, all = false, dryRun = false } = {}) {
  project = resolve(project);
  if (Boolean(note) === Boolean(all)) throw new Error("specify one note or --all");
  const files = existsSync(memoryDir) ? readdirSync(memoryDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md").map(entry => entry.name).sort() : [];
  let selected = files;
  if (!all) {
    const requested = note.endsWith(".md") ? note : `${note}.md`;
    const name = basename(requested);
    if (name === "MEMORY.md") throw new Error("MEMORY.md is an index and cannot be pinned");
    if (resolve(memoryDir, requested) !== resolve(memoryDir, name) || !files.includes(name)) throw new Error(`note not found in project memory: ${note}`);
    selected = [name];
  }
  const targets = selected.flatMap(name => {
    const text = readFileSync(join(memoryDir, name), "utf8");
    try { return [...notePins(text), ...extractMentions(text, project, new Map()).map(mention => ({ file: mention.file }))]; }
    catch { return notePins(text); }
  });
  const nodes = refreshPinGraph(project, targets);
  if (!nodes) return { project, status: "pins off", message: "no graft graph, pins off", notes: [] };
  const date = new Date().toISOString().slice(0, 10);
  const siblingNotes = new Set(files);
  const plans = selected.map(name => {
    const path = join(memoryDir, name);
    const original = readFileSync(path, "utf8");
    try {
      return { name, path, original, ...planNote(original, project, nodes, date, siblingNotes) };
    } catch (error) {
      return { name, path, original, text: original, pins: notePins(original), diagnostics: [error.message] };
    }
  });
  if (!dryRun) {
    for (const plan of plans) {
      if (readFileSync(plan.path, "utf8") !== plan.original) throw new Error(`note changed during pinning: ${plan.name}; retry`);
    }
    for (const plan of plans) if (plan.text !== plan.original) atomicNoteWrite(plan);
  }
  return { project, status: dryRun ? "dry run" : "pinned", notes: plans.map(plan => ({
    name: plan.name, pins: plan.pins, diagnostics: plan.diagnostics, changed: plan.text !== plan.original,
  })) };
}

function atomicNoteWrite(plan) {
  const temp = join(dirname(plan.path), `.${basename(plan.path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, plan.text, { flag: "wx", mode: statSync(plan.path).mode });
    if (readFileSync(plan.path, "utf8") !== plan.original) throw new Error(`note changed during pinning: ${plan.name}; retry`);
    renameSync(temp, plan.path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function formatMemoryPin(result) {
  if (result.message) return result.message;
  return result.notes.map(note => {
    const pins = note.pins.map(pin => pinTarget(pin)).map(pin => pin?.symbol || pin?.file || "invalid pin");
    return `${note.name}: ${result.status} — ${pins.join(", ") || "no pins"}${note.diagnostics.map(message => `\n  ${message}`).join("")}`;
  }).join("\n");
}
