// Git porcelain codes to what the Explorer shows beside a file: a letter, a tone, a plain label (#13987 drill).

export type Tone = "ok" | "warn" | "bad" | "accent";
export type Decoration = {
  letter: string;
  tone: Tone;
  /** "Modified", "Untracked"... */
  label: string;
  /** "staged" / "not staged" / "partly staged", or "" when staging does not apply or is unknown. */
  staging: string;
  /** Roll-up priority for folders: conflict 4 > deleted 3 > modified/renamed 2 > added/untracked 1. */
  rank: number;
};

export const TONE_VAR = {
  ok: "var(--v2-ok)", warn: "var(--v2-warn)", bad: "var(--v2-bad)", accent: "var(--v2-accent)",
} as const satisfies Record<Tone, string>;

const CONFLICT: Decoration = { letter: "!", tone: "bad", label: "Conflicted", staging: "", rank: 4 };
const DELETED: Decoration = { letter: "D", tone: "bad", label: "Deleted", staging: "", rank: 3 };
const MODIFIED: Decoration = { letter: "M", tone: "warn", label: "Modified", staging: "", rank: 2 };
const RENAMED: Decoration = { letter: "R", tone: "accent", label: "Renamed", staging: "", rank: 2 };
const ADDED: Decoration = { letter: "A", tone: "ok", label: "Added", staging: "", rank: 1 };
const UNTRACKED: Decoration = { letter: "U", tone: "ok", label: "Untracked", staging: "", rank: 1 };

const isConflict = (x: string, y: string) => x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");

function stagingOf(x: string, y: string): string {
  const staged = x !== " " && x !== "?";
  const unstaged = y !== " " && y !== "?";
  if (staged && unstaged) return "partly staged";
  return staged ? "staged" : unstaged ? "not staged" : "";
}

/** One porcelain XY pair (X = index, Y = worktree) to one decoration; null when git has nothing to say. */
export function decorate(rawX: string, rawY: string): Decoration | null {
  const x = rawX || " ";
  const y = rawY || " ";
  if (x === "!" || (x === " " && y === " ")) return null;
  if (x === "?" && y === "?") return UNTRACKED;
  if (isConflict(x, y)) return CONFLICT;
  const staging = stagingOf(x, y);
  if (x === "D" || y === "D") return { ...DELETED, staging };
  if (x === "R") return { ...RENAMED, staging };
  if (x === "A" || x === "C") return { ...ADDED, staging };
  return { ...MODIFIED, staging };
}

/** The listing's trimmed code ("M", "??") loses which side changed, so no staging claim is made. */
export function decorateCode(code: string): Decoration | null {
  if (!code) return null;
  if (code === "??") return UNTRACKED;
  const d = code.length > 1 ? decorate(code[0], code[1]) : "ADRCU".includes(code) ? decorate(code, " ") : decorate(" ", code);
  return d ? { ...d, staging: "" } : null;
}

/** "Modified, not staged". */
export const decorationTitle = (d: Decoration) => (d.staging ? `${d.label}, ${d.staging}` : d.label);

export type GitPath = { path: string; x: string; y: string };
export type FolderMark = { count: number; top: Decoration };

/** Every ancestor folder of a changed path: how many changed files sit inside, and the most important change. */
export function rollUp(entries: GitPath[]): Map<string, FolderMark> {
  const marks = new Map<string, FolderMark>();
  for (const e of entries) {
    const d = decorate(e.x, e.y);
    if (!d) continue;
    const parts = e.path.replace(/\/$/, "").split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const cur = marks.get(dir);
      marks.set(dir, cur ? { count: cur.count + 1, top: d.rank > cur.top.rank ? d : cur.top } : { count: 1, top: d });
    }
  }
  return marks;
}

export const folderTitle = (count: number) => `${count} changed ${count === 1 ? "file" : "files"} inside`;

export function countsLabel(plus?: number | null, minus?: number | null): string {
  return plus == null || minus == null ? "" : `+${plus} −${minus}`;
}

export type LegendItem = { letter: string; tone: Tone; name: string; sentence: string };
export const LEGEND: LegendItem[] = [
  { letter: "M", tone: "warn", name: "Modified", sentence: "a tracked file with changes" },
  { letter: "A", tone: "ok", name: "Added", sentence: "a new file git was told to track (staged)" },
  { letter: "U", tone: "ok", name: "Untracked", sentence: "a new file git is not tracking yet" },
  { letter: "D", tone: "bad", name: "Deleted", sentence: "a tracked file that was removed" },
  { letter: "R", tone: "accent", name: "Renamed", sentence: "a file that was moved or renamed" },
  { letter: "!", tone: "bad", name: "Conflicted", sentence: "both sides changed it; resolve before committing" },
];
