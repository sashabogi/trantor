import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isMap, parseDocument, stringify } from "yaml";
import { checkPin, memoryDirectory, notePins, pinTarget, refreshPinGraph, symbolFingerprint } from "./memory-pins.mjs";

function frontMatter(text) {
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

export function extractMentions(text, project, nodes) {
  const front = frontMatter(text);
  const body = (front ? text.slice(front.end) : text)
    .replace(/\[\[[\s\S]*?\]\]/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  const paths = new Set([...nodes.values()].map(node => node.path));
  const mentions = [];
  const seen = new Set();
  const pattern = /(?<![\w./\\-])((?:\.\/)?(?:[\w@.-]+\/)*[\w@.-]+)(?:#([\w$.-]+)|:(\d+))?/g;
  for (const match of body.matchAll(pattern)) {
    const file = match[1].replace(/^\.\//, "").replace(/[.,]+$/, "");
    if (!pinTarget({ file })) continue;
    const onDisk = existsSync(join(project, file)) && statSync(join(project, file)).isFile();
    if (!paths.has(file) && !onDisk && !(file.includes("/") && /\.[\w]+$/.test(file))) continue;
    const symbol = match[2]?.replace(/\.+$/, "");
    const mention = symbol ? { file, symbol: `${file}#${symbol}` }
      : match[3] ? { file, line: Number(match[3]) } : { file };
    const key = JSON.stringify(mention);
    if (!seen.has(key)) { seen.add(key); mentions.push(mention); }
  }
  return mentions;
}

function resolveMention(mention, nodes, project) {
  if (mention.symbol) return nodes.has(mention.symbol) ? { symbol: mention.symbol, fp: symbolFingerprint(project, nodes.get(mention.symbol)) } : null;
  if (mention.line === undefined) return { file: mention.file };
  const enclosing = [...nodes.values()].filter(node => node.path === mention.file && node.kind !== "file")
    .map(node => ({ node, span: /^L(\d+)-L(\d+)$/.exec(node.span) }))
    .filter(({ span }) => span && +span[1] <= mention.line && +span[2] >= mention.line)
    .sort((a, b) => (+a.span[2] - +a.span[1]) - (+b.span[2] - +b.span[1]));
  return enclosing.length ? { symbol: enclosing[0].node.id, fp: symbolFingerprint(project, enclosing[0].node) } : null;
}

function planNote(text, project, nodes, date) {
  const pins = notePins(text);
  const diagnostics = [];
  const keys = new Set(pins.map(pin => pinTarget(pin)).filter(Boolean).map(pin => pin.symbol || pin.file));
  for (const mention of extractMentions(text, project, nodes)) {
    const pin = resolveMention(mention, nodes, project);
    if (!pin) { diagnostics.push(`unresolved mention: ${mention.symbol || `${mention.file}:${mention.line}`}`); continue; }
    const key = pin.symbol || pin.file;
    if (!keys.has(key)) { pins.push(pin); keys.add(key); }
  }
  const refreshed = pins.map(pin => {
    const checked = checkPin(pin, project, nodes);
    if (checked.status === "broken" || checked.status === "invalid pin") {
      diagnostics.push(`${checked.status}: ${checked.detail}`);
      return pin;
    }
    const refreshed = { ...pin, at: date };
    if (checked.actual) refreshed.fp = checked.actual;
    return refreshed;
  });
  return { pins: refreshed, diagnostics, text: refreshed.length ? replaceNotePins(text, refreshed) : text };
}

export function pinMemory({ project = process.cwd(), memoryDir = memoryDirectory(project), note, all = false, dryRun = false } = {}) {
  project = resolve(project);
  if (Boolean(note) === Boolean(all)) throw new Error("specify one note or --all");
  const files = existsSync(memoryDir) ? readdirSync(memoryDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md")).map(entry => entry.name).sort() : [];
  let selected = files;
  if (!all) {
    const requested = note.endsWith(".md") ? note : `${note}.md`;
    const name = basename(requested);
    if (resolve(memoryDir, requested) !== resolve(memoryDir, name) || !files.includes(name)) throw new Error(`note not found in project memory: ${note}`);
    selected = [name];
  }
  const nodes = refreshPinGraph(project);
  if (!nodes) return { project, status: "pins off", message: "no graft graph, pins off", notes: [] };
  const date = new Date().toISOString().slice(0, 10);
  const plans = selected.map(name => {
    const path = join(memoryDir, name);
    const original = readFileSync(path, "utf8");
    try {
      return { name, path, original, ...planNote(original, project, nodes, date) };
    } catch (error) {
      return { name, path, original, text: original, pins: notePins(original), diagnostics: [error.message] };
    }
  });
  if (!dryRun) {
    for (const plan of plans) {
      if (readFileSync(plan.path, "utf8") !== plan.original) throw new Error(`note changed during pinning: ${plan.name}; retry`);
    }
    for (const plan of plans) if (plan.text !== plan.original) writeFileSync(plan.path, plan.text);
  }
  return { project, status: dryRun ? "dry run" : "pinned", notes: plans.map(plan => ({
    name: plan.name, pins: plan.pins, diagnostics: plan.diagnostics, changed: plan.text !== plan.original,
  })) };
}

export function formatMemoryPin(result) {
  if (result.message) return result.message;
  return result.notes.map(note => {
    const pins = note.pins.map(pin => pinTarget(pin)).map(pin => pin?.symbol || pin?.file || "invalid pin");
    return `${note.name}: ${result.status} — ${pins.join(", ") || "no pins"}${note.diagnostics.map(message => `\n  ${message}`).join("")}`;
  }).join("\n");
}
