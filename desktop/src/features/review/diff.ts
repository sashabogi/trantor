// Unified-diff parsing for the REVIEW lens — a PURE function: no DOM, no hub, no invoke. The
// component feeds it the raw `patch` string from codex's frozen seat_diff command (#5366) and
// renders what comes back; everything testable about the diff lives here so the tests never
// touch React.
//
// Scope is exactly what `git diff <base>` emits: `diff --git` file headers, ---/+++ path lines
// (/dev/null for new/deleted), @@ hunk headers, and +/-/space body lines. Line numbers are
// computed for both sides so the gutter can show them; "\ No newline at end of file" is dropped.

export type DiffLine = {
  kind: "add" | "del" | "ctx";
  text: string;
  /** Line number on the OLD side — null for added lines. */
  oldNo: number | null;
  /** Line number on the NEW side — null for deleted lines. */
  newNo: number | null;
};

export type DiffHunk = {
  /** The raw @@ line, minus the leading/trailing @@ markers' decoration — rendered muted. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type DiffFile = {
  /** The NEW-side path (b/…), or the old path when the file was deleted. */
  path: string;
  oldPath: string | null;
  hunks: DiffHunk[];
  adds: number;
  dels: number;
  isNew: boolean;
  isDeleted: boolean;
};

export type ParsedPatch = {
  files: DiffFile[];
  adds: number;
  dels: number;
  /** Passthrough of seat_diff's 400KB cap flag — the lens badges a capped patch rather than
   * letting a silently-shortened diff read as the whole change. */
  truncated: boolean;
};

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string, truncated = false): ParsedPatch {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  // A git patch ends with a newline; splitting raw would leave a final "" that parses as a
  // phantom context line inside the last hunk.
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  for (const raw of body.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = { path: "", oldPath: null, hunks: [], adds: 0, dels: 0, isNew: false, isDeleted: false };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;                       // preamble (index lines etc.) before any file
    if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      file.oldPath = p === "/dev/null" ? null : p.replace(/^a\//, "");
      if (p === "/dev/null") file.isNew = true;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (p === "/dev/null") {
        file.isDeleted = true;
        file.path = file.oldPath ?? "";
      } else {
        file.path = p.replace(/^b\//, "");
      }
      continue;
    }
    const hm = HUNK_RE.exec(raw);
    if (hm) {
      oldNo = Number(hm[1]);
      newNo = Number(hm[2]);
      hunk = { header: raw, oldStart: oldNo, newStart: newNo, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;                       // index:/similarity lines between header and hunks
    if (raw.startsWith("\\")) continue;        // "\ No newline at end of file"
    const kind = raw[0];
    if (kind === "+") {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
      file.adds++;
    } else if (kind === "-") {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
      file.dels++;
    } else {
      // Context lines lead with a space; a totally empty line inside a hunk is context too
      // (git prints a lone space, but hand-built patches and caps can lose it).
      hunk.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }

  // A file header with no hunks and no content (mode-only change, binary) carries no signal for
  // a review lens — drop it rather than render an empty box that looks like a load failure.
  const real = files.filter(f => f.hunks.length > 0 || f.adds > 0 || f.dels > 0);
  return {
    files: real,
    adds: real.reduce((n, f) => n + f.adds, 0),
    dels: real.reduce((n, f) => n + f.dels, 0),
    truncated,
  };
}
