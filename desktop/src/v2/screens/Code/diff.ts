// Parsing git's own unified diff into files, hunks and side-by-side rows (#13988). Pure.
export type DiffLine = { kind: "ctx" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
  side?: "staged" | "unstaged";
  path: string;
  status: "M" | "A" | "D" | "R";
  plus: number;
  minus: number;
  binary: boolean;
  hunks: DiffHunk[];
};

const FILE_HEAD = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function blankFile(path: string): DiffFile {
  return { path, status: "M", plus: 0, minus: 0, binary: false, hunks: [] };
}

function applyMeta(file: DiffFile, line: string): boolean {
  if (line.startsWith("new file mode")) file.status = "A";
  else if (line.startsWith("deleted file mode")) file.status = "D";
  else if (line.startsWith("rename from")) file.status = "R";
  else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) file.binary = true;
  else return false;
  return true;
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    const head = FILE_HEAD.exec(line);
    if (head) { file = blankFile(head[2]); hunk = null; files.push(file); continue; }
    if (!file) continue;
    const h = HUNK_HEAD.exec(line);
    if (h) { oldNo = Number(h[1]); newNo = Number(h[2]); hunk = { header: line, lines: [] }; file.hunks.push(hunk); continue; }
    if (!hunk) { applyMeta(file, line); continue; }
    if (line.startsWith("+")) { hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ }); file.plus++; }
    else if (line.startsWith("-")) { hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null }); file.minus++; }
    else if (line.startsWith(" ")) hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return files;
}

export type SideRow = { left: DiffLine | null; right: DiffLine | null };

/** A run of deletions followed by additions pairs up line for line; the rest sit alone. */
export function pairHunk(hunk: DiffHunk): SideRow[] {
  const rows: SideRow[] = [];
  const dels: DiffLine[] = [];
  const adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels.length = 0;
    adds.length = 0;
  };
  for (const l of hunk.lines) {
    if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else { flush(); rows.push({ left: l, right: l }); }
  }
  flush();
  return rows;
}

/** A hunk as text, for "Add to chat". */
export function hunkText(file: DiffFile, hunk: DiffHunk): string {
  const sign = { ctx: " ", add: "+", del: "-" } as const;
  return [`${file.path}`, hunk.header, ...hunk.lines.map(l => `${sign[l.kind]}${l.text}`)].join("\n");
}

const SIGN = { ctx: " ", add: "+", del: "-" } as const;
const HUNK_NUMBERS = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function filePatchHeader(file: DiffFile): string[] {
  const mode = file.status === "A" ? "new file mode 100644" : file.status === "D" ? "deleted file mode 100644" : null;
  return [
    `diff --git a/${file.path} b/${file.path}`,
    ...(mode ? [mode] : []),
    `--- ${file.status === "A" ? "/dev/null" : `a/${file.path}`}`,
    `+++ ${file.status === "D" ? "/dev/null" : `b/${file.path}`}`,
  ];
}

export function patchForHunk(file: DiffFile, hunk: DiffHunk): string {
  return [...filePatchHeader(file), hunk.header, ...hunk.lines.map(line => `${SIGN[line.kind]}${line.text}`), ""].join("\n");
}

/** `reverse` is for unstage and discard: the patch then lands on the new side, so what is left out must match that side. */
export function patchForLines(file: DiffFile, hunk: DiffHunk, selected: ReadonlySet<number>, reverse = false): string {
  const lines = hunk.lines.flatMap((line, index) => {
    if (line.kind === "ctx") return [` ${line.text}`];
    if (selected.has(index)) return [`${SIGN[line.kind]}${line.text}`];
    return line.kind === (reverse ? "add" : "del") ? [` ${line.text}`] : [];
  });
  if (!lines.some(line => line.startsWith("+") || line.startsWith("-"))) throw new Error("Select at least one changed line");
  const match = HUNK_NUMBERS.exec(hunk.header);
  if (!match) throw new Error("This hunk header cannot be applied");
  const oldStart = Number(reverse ? match[3] : match[1]);
  const oldCount = lines.filter(line => line.startsWith(" ") || line.startsWith("-")).length;
  const newCount = lines.filter(line => line.startsWith(" ") || line.startsWith("+")).length;
  const newStart = newCount === 0 ? Math.max(0, oldStart - 1) : oldStart === 0 ? 1 : oldStart;
  const suffix = hunk.header.slice(hunk.header.indexOf("@@", 2) + 2);
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${suffix}`;
  return [...filePatchHeader(file), header, ...lines, ""].join("\n");
}
