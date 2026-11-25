// Pure rules behind the Code screen (#13988): card parsing, seat derivation, history search,
// branch grouping and the sidebar-fold rule. No React, no IPC, so each rule is tested alone.
import type { Presence } from "../../ui/identity";

/** The first "#12345" in a commit subject is the card it belongs to; shorter numbers are noise. */
export function parseCardRef(subject: string): number | null {
  const m = /#(\d{3,7})\b/.exec(subject);
  return m ? Number(m[1]) : null;
}

export type SeatCtx = { seats: readonly string[]; branch: string | null };
export type CommitLike = { author: string; subject: string; trailers?: string };

/** Which seat wrote a commit: a Seat trailer first, then the author name, then the seat/* branch
 *  it sits on. A human author on a non-seat branch yields null, never a guess. */
export function deriveSeat(commit: CommitLike, ctx: SeatCtx): string | null {
  const trailer = /^Seat:\s*(\S+)/im.exec(commit.trailers ?? "");
  if (trailer) return trailer[1];
  const author = commit.author.toLowerCase();
  const byName = [...ctx.seats].sort((a, b) => b.length - a.length).find(s => author.includes(s.toLowerCase()));
  if (byName) return byName;
  if (author.includes("orchestrator")) return "orchestrator";
  const onSeatBranch = /^seat\/(.+)$/.exec(ctx.branch ?? "");
  return onSeatBranch ? onSeatBranch[1] : null;
}

export type HistoryQuery = { text: string; author?: string; seat?: string; card?: number; file?: string };

/** "fix author:codex card:13970 file:a.ts" into its parts; unknown words stay free text. */
export function parseSearch(raw: string): HistoryQuery {
  const q: HistoryQuery = { text: "" };
  const free: string[] = [];
  for (const word of raw.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(author|seat|card|file):(.*)$/i.exec(word);
    if (!m || !m[2]) { free.push(word); continue; }
    const key = m[1].toLowerCase();
    if (key === "author") q.author = m[2].toLowerCase();
    else if (key === "seat") q.seat = m[2].toLowerCase();
    else if (key === "file") q.file = m[2];
    else if (/^#?\d+$/.test(m[2])) q.card = Number(m[2].replace("#", ""));
  }
  q.text = free.join(" ").toLowerCase();
  return q;
}

export type HistoryRow = { sha: string; author: string; when: string; subject: string; seat: string | null; card: number | null };

export function toRow(c: { sha: string; author: string; when: string; subject: string }, ctx: SeatCtx): HistoryRow {
  return { ...c, seat: deriveSeat(c, ctx), card: parseCardRef(c.subject) };
}

/** Rows matching every given key. A file: filter cannot be answered from the log (it has no per-commit
 *  file lists), so it is reported back instead of silently matching nothing. */
export type HistoryResult = { rows: HistoryRow[]; fileUnsupported: boolean };

export function filterHistory(rows: readonly HistoryRow[], q: HistoryQuery): HistoryResult {
  const kept = rows.filter(r => {
    if (q.author && !r.author.toLowerCase().includes(q.author)) return false;
    if (q.seat && !(r.seat ?? "").toLowerCase().includes(q.seat)) return false;
    if (q.card !== undefined && r.card !== q.card) return false;
    if (q.text && !`${r.subject} ${r.sha} ${r.author}`.toLowerCase().includes(q.text)) return false;
    return true;
  });
  return { rows: kept, fileUnsupported: !!q.file };
}

export type SeatInfo = { seat: string; presence: Presence; branch: string | null; ahead: number | null; machine: string | null; hasWorktree: boolean };
export type BranchGroups = {
  checkout: { label: string }[];
  seats: (SeatInfo & { branchLabel: string })[];
};

/** The picker's sections. Seats are listed under their seat/<name> branch; the project checkout is
 *  its own section. "Other local" and "Remote" have no reader yet, so they are not grouped here. */
export function groupBranches(input: { seats: readonly SeatInfo[]; filter: string; show: "all" | "seats"; sort: "recent" | "name" }): BranchGroups {
  const f = input.filter.trim().toLowerCase();
  const labelled = input.seats.filter(s => s.hasWorktree).map(s => ({ ...s, branchLabel: s.branch || `seat/${s.seat}` }));
  const seats = labelled.filter(s => !f || `${s.branchLabel} ${s.seat}`.toLowerCase().includes(f));
  if (input.sort === "name") seats.sort((a, b) => a.branchLabel.localeCompare(b.branchLabel));
  const checkout = input.show === "seats" || (f && !"project checkout".includes(f)) ? [] : [{ label: "project checkout" }];
  return { checkout, seats };
}

export type MainTab = "source" | "file" | "conflict";

/** The operator's rule: while the full Source control tab (or a PR) is open, its sidebar folds into
 *  the icon bar so the diff gets the width; the tab-bar button can bring it back (#13988). */
export function sidebarVisible(active: MainTab, override: boolean): boolean {
  const fullView = active === "source" || active === "conflict";
  return fullView ? override : true;
}

export type Letter = "A" | "D" | "R" | "M";

export function fileChipLabel(code: string): Letter {
  if (code === "??" || code.startsWith("A")) return "A";
  if (code.startsWith("D")) return "D";
  if (code.startsWith("R")) return "R";
  return "M";
}

/** The change the diff shows (#14044): the operator's pick, else the intent's focus, else the
 *  first chip. A pick that vanished from the list falls through rather than showing nothing. */
export function pickChange(paths: readonly string[], picked: string | null, focus: string | null): string | null {
  if (picked && paths.includes(picked)) return picked;
  if (focus && paths.includes(focus)) return focus;
  return paths[0] ?? null;
}

/** "5m" style age from epoch ms, for the toolbar's read-ago text. */
export function readAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}
