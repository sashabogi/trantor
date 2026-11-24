// Parsing git's own unified diff into files, hunks and side-by-side rows (#13988). Pure.
export type DiffLine = { kind: "ctx" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
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
