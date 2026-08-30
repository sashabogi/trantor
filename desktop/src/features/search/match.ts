// The search vocabulary, defined ONCE (#5625): plain text matches titles and assignees, `#123`
// a card id, `@name` an assignee. The board's inline filter spoke this since #5367; the palette
// (project ⌘F-style trigger + global ⌘K) speaks the SAME language from the same function, so
// "search" can never mean two things in one app.
import type { Card } from "../../shared/api/client";

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
  | { kind: "card"; project: string; card: Card };

/** The palette's one result list: projects first (global scope only), then cards, capped so the
 *  dropdown stays a glance, never a page. */
export function paletteHits(
  query: string,
  projects: string[],
  cardsByProject: Record<string, Card[]>,
  opts: { includeProjects: boolean; cap?: number } = { includeProjects: true },
): PaletteHit[] {
  const cap = opts.cap ?? 12;
  const hits: PaletteHit[] = [];
  if (opts.includeProjects) {
    for (const p of matchProjects(projects, query)) hits.push({ kind: "project", project: p });
  }
  const q = query.trim();
  if (q) {
    for (const [project, cards] of Object.entries(cardsByProject)) {
      for (const card of cards) {
        if (hits.length >= cap) return hits;
        if (matchesCard(card, q)) hits.push({ kind: "card", project, card });
      }
    }
  }
  return hits.slice(0, cap);
}
