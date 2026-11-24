// Reading and resolving git's conflict markers in a file's text (#13988). Pure.
export type TextChunk = { kind: "text"; text: string };
export type ConflictChunk = { kind: "conflict"; ours: string; theirs: string; oursLabel: string; theirsLabel: string };
export type Chunk = TextChunk | ConflictChunk;
export type Choice = "ours" | "theirs" | "both";

const START = /^<{7}(?: (.*))?$/;
const MID = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;

type Side = "text" | "ours" | "base" | "theirs";

export function parseConflicts(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let side: Side = "text";
  let buf: string[] = [];
  let ours: string[] = [];
  let theirs: string[] = [];
  let oursLabel = "";
  const flushText = () => { if (buf.length) chunks.push({ kind: "text", text: buf.join("\n") + "\n" }); buf = []; };
  for (const line of text.split("\n")) {
    const s = START.exec(line);
    if (side === "text" && s) { flushText(); side = "ours"; oursLabel = s[1] ?? ""; ours = []; theirs = []; continue; }
    if (side === "ours" && BASE.test(line)) { side = "base"; continue; }
    if ((side === "ours" || side === "base") && MID.test(line)) { side = "theirs"; continue; }
    const e = END.exec(line);
    if (side === "theirs" && e) {
      chunks.push({ kind: "conflict", ours: ours.join("\n"), theirs: theirs.join("\n"), oursLabel, theirsLabel: e[1] ?? "" });
      side = "text";
      continue;
    }
    if (side === "text") buf.push(line);
    else if (side === "ours") ours.push(line);
    else if (side === "theirs") theirs.push(line);
  }
  if (side === "text" && buf.length) {
    // the split leaves one empty tail element when the file ended with a newline
    if (buf[buf.length - 1] === "") buf.pop();
    flushText();
  }
  return chunks;
}

export function countConflicts(chunks: readonly Chunk[]): number {
  return chunks.filter(c => c.kind === "conflict").length;
}

const join = (a: string, b: string) => [a, b].filter(s => s !== "").join("\n");

function pickText(c: ConflictChunk, pick: Choice): string {
  if (pick === "ours") return c.ours;
  if (pick === "theirs") return c.theirs;
  return join(c.ours, c.theirs);
}

/** The file text with each conflict replaced by its pick; an unpicked conflict keeps its markers. */
export function resolveChunks(chunks: readonly Chunk[], picks: ReadonlyMap<number, Choice>): string {
  let n = -1;
  let out = "";
  for (const c of chunks) {
    if (c.kind === "text") { out += c.text; continue; }
    n++;
    const pick = picks.get(n);
    if (!pick) { out += `<<<<<<< ${c.oursLabel}\n${c.ours}\n=======\n${c.theirs}\n>>>>>>> ${c.theirsLabel}\n`; continue; }
    const body = pickText(c, pick);
    out += body === "" ? "" : `${body}\n`;
  }
  return out;
}
