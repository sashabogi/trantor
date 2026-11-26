// A thin column of ticks on the chat's left edge: one per message the operator sent, read from the chat's DOM (#14075).
// #14327: 8x2px ticks on a 6px pitch, muted at half strength, the ones on screen at 90%, the active one
// wider and taller in the text colour. It overlays the transcript's gutter from the top, so it takes no width.
// #14250: ticks widen around the pointer and the card explains: place, reply's first line, worked time.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ago } from "../../../shared/time";
import { activeIndex, readPrompts, samePrompts, showsTimeline, tickLabel, tickWidth, workedText, type PromptItem } from "./promptTicks";

const SELECTOR = "[data-prompt-id]";

function scrollerOf(el: HTMLElement, root: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n && root.contains(n); n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
}

/** Follows the chat DOM: the prompts in order and which one is on screen. */
function useTimeline(root: RefObject<HTMLElement | null>) {
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [active, setActive] = useState(0);
  const [onScreen, setOnScreen] = useState<boolean[]>([]);
  const scroller = useRef<HTMLElement | null>(null);
  const sync = useCallback(() => {
    const host = root.current;
    if (!host) return;
    const els = Array.from(host.querySelectorAll<HTMLElement>(SELECTOR)).filter(e => e.textContent?.trim());
    const next = readPrompts(els);
    setPrompts(prev => (samePrompts(prev, next) ? prev : next));
    const sc = els[0] ? scrollerOf(els[0], host) : null;
    if (sc !== scroller.current) {
      scroller.current?.removeEventListener("scroll", sync);
      sc?.addEventListener("scroll", sync, { passive: true });
      scroller.current = sc;
    }
    if (!sc) return;
    const base = sc.getBoundingClientRect();
    const rects = els.map(e => e.getBoundingClientRect());
    setActive(activeIndex(rects.map(r => r.top - base.top)));
    const seen = rects.map(r => r.bottom > base.top && r.top < base.bottom);
    setOnScreen(prev => (prev.length === seen.length && prev.every((v, i) => v === seen[i]) ? prev : seen));
  }, [root]);
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    sync();
    // A streaming reply mutates the chat many times a second: read the layout once per frame at most.
    let frameId = 0;
    const soon = () => { if (!frameId) frameId = requestAnimationFrame(() => { frameId = 0; sync(); }); };
    const mo = new MutationObserver(soon);
    mo.observe(host, { childList: true, subtree: true, characterData: true });
    const ro = "ResizeObserver" in globalThis ? new ResizeObserver(soon) : null;
    ro?.observe(host);
    return () => {
      mo.disconnect(); ro?.disconnect(); cancelAnimationFrame(frameId);
      scroller.current?.removeEventListener("scroll", sync); scroller.current = null;
    };
  }, [root, sync]);
  const jump = useCallback((id: string) => {
    const els = Array.from(root.current?.querySelectorAll<HTMLElement>(SELECTOR) ?? []);
    els.find(e => e.getAttribute("data-prompt-id") === id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [root]);
  return { prompts, active, onScreen, jump };
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Where the card hangs: the tick row's vertical middle and the window x of the row's right edge. */
type Anchor = { y: number; left: number };

const anchorOf = (row: HTMLElement): Anchor => {
  const r = row.getBoundingClientRect();
  return { y: r.top + r.height / 2, left: r.right };
};

function Card({ prompt, index, total, at, onOpenChange }: { prompt: PromptItem; index: number; total: number; at: Anchor; onOpenChange: (path: string) => void }) {
  const files = prompt.files ?? [];
  // Only the parts that exist: worked time, the prompt's age, or both joined.
  const timing = [
    prompt.workedMs !== undefined ? `Worked ${workedText(prompt.workedMs)}` : null,
    prompt.ts !== undefined ? ago(prompt.ts) : null,
  ].filter(Boolean).join(" · ");
  return (
    // No gap and real pointer events (#14084): the card must be reachable from its tick so a
    // file name can be clicked, and hover crossing from tick to card must not close it.
    // #14254: fixed to the window, because the tick column scrolls and would clip a card positioned inside it.
    <div role="tooltip" style={{ top: at.y, left: at.left }} className="v2-fade-in fixed z-30 w-60 -translate-y-1/2 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-2 text-left shadow-lg">
      <div className="v2-mono text-v2-small text-[var(--v2-muted)]">{index + 1} / {total}</div>
      <div className="mt-0.5 text-v2-body font-medium leading-snug text-[var(--v2-text)]" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{prompt.text}</div>
      {prompt.reply !== undefined && <div className="mt-0.5 truncate text-v2-body text-[var(--v2-text-2)]">{prompt.reply}</div>}
      {timing && <div className="mt-1 text-v2-small text-[var(--v2-muted)]">{timing}</div>}
      {files.length > 0 && (
        <div className="mt-1 text-v2-small text-[var(--v2-muted)]">
          Changed {files.length} {files.length === 1 ? "file" : "files"}
          <div className="mt-0.5 flex flex-wrap gap-1">
            {files.slice(0, 5).map(f => (
              <button key={f} type="button" title={f} onClick={() => onOpenChange(f)}
                className="rounded border border-[var(--v2-edge-2)] px-1 py-0.5 text-v2-micro text-[var(--v2-text)] hover:border-[var(--v2-accent)]">
                {baseName(f)}
              </button>
            ))}
            {files.length > 5 && <span>and {files.length - 5} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function PromptTimeline({ root, onOpenChange }: { root: RefObject<HTMLElement | null>; onOpenChange: (path: string) => void }) {
  const { prompts, active, onScreen, jump } = useTimeline(root);
  const [shown, setShown] = useState<number | null>(null);
  const [at, setAt] = useState<Anchor>({ y: 0, left: 0 });
  const [rove, setRove] = useState<number | null>(null);
  const ticks = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : null;
    if (to === null || to < 0 || to >= prompts.length) return;
    e.preventDefault();
    setRove(to);
    ticks.current[to]?.focus();
  };
  if (!showsTimeline(prompts.length)) return null;
  const tabbable = Math.min(rove ?? active, prompts.length - 1);
  return (
    <nav aria-label="Prompt timeline" className="pointer-events-none absolute left-[3px] top-[18px] z-10 flex max-h-[calc(100%-36px)] w-7 flex-col items-start overflow-y-auto">
      {prompts.map((p, i) => (
        <div key={p.id} className="pointer-events-auto relative flex h-1.5 w-full shrink-0 items-center justify-start"
          onMouseEnter={e => { setAt(anchorOf(e.currentTarget)); setShown(i); }} onMouseLeave={() => setShown(null)}
          onFocus={e => { setAt(anchorOf(e.currentTarget)); setShown(i); setRove(i); }}
          onBlur={e => {
            // SAFETY: relatedTarget is the element taking focus next; Node is its DOM type here.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setShown(null);
          }}>
          <button type="button" ref={el => { ticks.current[i] = el; }} aria-label={tickLabel(i, prompts.length, p.text)}
            aria-current={i === active ? "true" : undefined} tabIndex={i === tabbable ? 0 : -1}
            onClick={() => jump(p.id)} onKeyDown={e => onKey(e, i)}
            className="flex h-full w-full items-center justify-start">
            {/* #14250: width follows the pointer (or rests on 8px, the active one 14px), strength follows the state. */}
            <span aria-hidden className={`v2-tick block rounded-full ${i === active ? "h-[2.5px] bg-[var(--v2-text)]" : `h-[2px] bg-[var(--v2-muted)] ${onScreen[i] ? "opacity-90" : "opacity-50"}`} ${shown === null ? (i === active ? "w-3.5" : "w-2") : ""}`}
              style={shown === null ? undefined : { width: `${tickWidth(i - shown)}px` }} />
          </button>
          {shown === i && <Card prompt={p} index={i} total={prompts.length} at={at} onOpenChange={onOpenChange} />}
        </div>
      ))}
    </nav>
  );
}
