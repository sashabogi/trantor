import { ago } from "../../../shared/time";
import type { BrowserPreview } from "./browserModel";

export type SeatPreview = BrowserPreview & { seat: string; label: string; tool: string; started: number; offered: boolean; machine?: string };
const EMPTY: SeatPreview[] = [];

export function createPreviewStore() {
  const projects = new Map<string, SeatPreview[]>();
  const listeners = new Set<() => void>();
  const read = (project: string) => projects.get(project) ?? EMPTY;
  const publish = (project: string, items: SeatPreview[]) => {
    projects.set(project, items);
    for (const notify of listeners) notify();
  };
  return {
    read,
    subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    detect(project: string, seat: string, label: string, url: string, tool: string, machine?: string) {
      if (read(project).some(p => p.url === url && p.seat === seat)) return;
      publish(project, [...read(project), { url, seat, label, tool, machine, started: Date.now(), note: "", running: true, offered: true }]);
    },
    end(project: string, seat: string) {
      if (!read(project).some(p => p.seat === seat && p.running)) return;
      publish(project, read(project).map(p => p.seat === seat ? { ...p, running: false, offered: false } : p));
    },
    opened(project: string, seat: string, url: string) {
      publish(project, read(project).map(p => p.seat === seat && p.url === url ? { ...p, offered: false } : p));
    },
  };
}
export const previewStore = createPreviewStore();
export type PreviewStore = ReturnType<typeof createPreviewStore>;
export const previewNote = (p: SeatPreview): string => `${p.tool}, started by ${p.label} ${ago(p.started)}${p.running ? "" : ", stopped"}`;

// Carry only an unfinished line across chunks; ANSI colours may split both names and URLs.
export function previewScanner(found: (url: string, tool: string) => void) {
  let tail = "";
  let tool = "dev server";
  const seen = new Set<string>();
  return (chunk: string) => {
    const text = (tail + chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const pattern = /\b(vite|next(?:\.js)?|astro|webpack|nuxt)\b|https?:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}(?:\/[^\s\x1b<>"']*)?(?=[\s\x1b<>"'),;]|$)/gi;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) { tool = match[1].toLowerCase(); continue; }
      // Wait for a delimiter: a chunk may stop halfway through the port or pathname.
      if (match.index + match[0].length === text.length) continue;
      const url = match[0].replace(/[),.;]+$/, "");
      try {
        const parsed = new URL(url);
        if (seen.has(parsed.href)) continue;
        seen.add(parsed.href);
        found(parsed.href, tool);
      } catch { /* A malformed port in terminal output is not a preview. */ }
    }
    tail = text.slice(text.lastIndexOf("\n") + 1).slice(-2048);
  };
}
