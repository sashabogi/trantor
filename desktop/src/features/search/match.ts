// The search vocabulary, defined ONCE (#5625): plain text matches titles and assignees, `#123`
// a card id, `@name` an assignee. The board's inline filter spoke this since #5367; the palette
// (project ⌘F-style trigger + global ⌘K) speaks the SAME language from the same function, so
// "search" can never mean two things in one app.
import type { Card, HubEvent } from "../../shared/api/client";

export function matchesCard(card: Card, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith("#")) return String(card.id).startsWith(q.slice(1));
  if (q.startsWith("@")) return (card.assignee || "").toLowerCase().includes(q.slice(1));
  return card.title.toLowerCase().includes(q) || (card.assignee || "").toLowerCase().includes(q);
}

/** Project rows for the GLOBAL palette: name containment, exact-prefix first so "tr" puts
 *  "trantor" above "crebral-cortex-tr-tools". */
export function matchProjects(projects: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q || q.startsWith("#") || q.startsWith("@")) return [];
  const hit = projects.filter(p => p.toLowerCase().includes(q));
  return hit.sort((a, b) => {
    const ap = a.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp || a.localeCompare(b);
  }).slice(0, 6);
}

export type PaletteHit =
  | { kind: "project"; project: string }
  | { kind: "card"; project: string; card: Card }
  | { kind: "message"; project: string; event: HubEvent; cardId: number | null }
  | { kind: "event"; project: string; event: HubEvent; label: string; cardId: number | null }
  | { kind: "file"; project: string; path: string };

type RankedHit = { hit: PaletteHit; rank: number; tiebreak: string };

type ExtraCorpus = {
  messagesByProject?: Record<string, HubEvent[]>;
  eventsByProject?: Record<string, HubEvent[]>;
  filesByProject?: Record<string, string[]>;
};

const CARD_TYPES = new Set(["created", "moved", "updated"]);
type SearchTextValue = string | number | boolean | null | undefined;

function lc(s: SearchTextValue): string {
  return String(s ?? "").toLowerCase();
}

function haystack(parts: SearchTextValue[]): string {
  return parts.map(lc).filter(Boolean).join(" ");
}

function textRank(text: string, q: string, base: number): number | null {
  if (!q) return null;
  const idx = text.indexOf(q);
  if (idx < 0) return null;
  return base + (text.startsWith(q) ? 0 : 10) + Math.min(idx, 50) / 100;
}

function firstCardRef(e: HubEvent): number | null {
  const taskId = e.taskId;
  if (taskId !== undefined && Number.isFinite(taskId)) return taskId;
  const m = /#(\d+)(?![0-9])/.exec(e.text ?? "");
  return m ? Number(m[1]) : null;
}

export function eventLabel(e: HubEvent): string {
  if (e.type === "message") return e.text ?? "";
  if (CARD_TYPES.has(e.type)) {
    const move = e.from && e.to ? `${e.from} -> ${e.to}` : e.status ? `-> ${e.status}` : e.type;
    return `#${e.taskId ?? "?"} ${move}${e.title ? ` · ${e.title}` : ""}`;
  }
  if (e.type === "file.claim") return `editing ${e.file ?? "a file"}`;
  if (e.type === "file.conflict") return `editing ${e.file ?? "a file"} with ${(e.with ?? []).join(", ")}`;
  if (e.type.startsWith("presence")) return `${e.by ?? ""} ${e.type}`;
  if (e.type.startsWith("handoff")) return `${e.by ?? ""} wrote a handoff`;
  if (e.type.startsWith("verify")) return `verify gate ${e.claim ?? e.detail ?? e.reason ?? ""}`;
  return e.title ?? e.text ?? e.detail ?? e.claim ?? e.type;
}

/** The palette's one result list: projects first (global scope only), then cards, capped so the
 *  dropdown stays a glance, never a page. */
export function paletteHits(
  query: string,
  projects: string[],
  cardsByProject: Record<string, Card[]>,
  opts: { includeProjects: boolean; cap?: number } = { includeProjects: true },
  extra: ExtraCorpus = {},
): PaletteHit[] {
  const cap = opts.cap ?? 12;
  const q = query.trim().toLowerCase();
  const ranked: RankedHit[] = [];
  if (opts.includeProjects) {
    for (const p of matchProjects(projects, query)) {
      const lower = p.toLowerCase();
      ranked.push({ hit: { kind: "project", project: p }, rank: lower === q ? 0 : lower.startsWith(q) ? 2 : 8, tiebreak: p });
    }
  }
  if (q) {
    for (const [project, cards] of Object.entries(cardsByProject)) {
      for (const card of cards) {
        const text = haystack([card.title, card.assignee, card.status, card.phase, card.summary]);
        let rank = textRank(text, q, 20);
        if (query.trim().startsWith("#") && String(card.id).startsWith(query.trim().slice(1))) rank = 10;
        if (query.trim().startsWith("@") && lc(card.assignee).includes(q.slice(1))) rank = 12;
        if (rank !== null) ranked.push({ hit: { kind: "card", project, card }, rank, tiebreak: `${project}:${card.id}` });
      }
    }
    for (const [project, events] of Object.entries(extra.messagesByProject ?? {})) {
      for (const event of events) {
        const text = haystack([event.text, event.by, event.toSession, project]);
        const rank = textRank(text, q, 40);
        if (rank !== null) ranked.push({ hit: { kind: "message", project, event, cardId: firstCardRef(event) }, rank, tiebreak: `${project}:${event.ts}:${event.id ?? 0}` });
      }
    }
    for (const [project, events] of Object.entries(extra.eventsByProject ?? {})) {
      for (const event of events) {
        if (event.type === "message") continue;
        const label = eventLabel(event);
        const text = haystack([event.type, label, event.by, event.file, event.status, project]);
        const rank = textRank(text, q, 60);
        if (rank !== null) ranked.push({ hit: { kind: "event", project, event, label, cardId: firstCardRef(event) }, rank, tiebreak: `${project}:${event.ts}:${event.id ?? 0}` });
      }
    }
    for (const [project, paths] of Object.entries(extra.filesByProject ?? {})) {
      for (const path of paths) {
        const rank = textRank(path.toLowerCase(), q, 80);
        if (rank !== null) ranked.push({ hit: { kind: "file", project, path }, rank, tiebreak: `${project}:${path}` });
      }
    }
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.tiebreak.localeCompare(b.tiebreak))
    .map(r => r.hit)
    .slice(0, cap);
}
