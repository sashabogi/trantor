// A thin column of ticks beside the chat: one per message the operator sent, read from the chat's DOM (#14075).
// #14241: it rides the chat's left edge, centred mid-height, 20px hit rows.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { when } from "../../../shared/time";
import { activeIndex, readPrompts, samePrompts, showsTimeline, tickLabel, type PromptItem } from "./promptTicks";

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
    setActive(activeIndex(els.map(e => e.getBoundingClientRect().top - base.top)));
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
  return { prompts, active, jump };
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function Card({ prompt, onOpenChange }: { prompt: PromptItem; onOpenChange: (path: string) => void }) {
  const files = prompt.files ?? [];
  return (
    // No gap and real pointer events (#14084): the card must be reachable from its tick so a
    // file name can be clicked, and hover crossing from tick to card must not close it.
    <div role="tooltip" className="absolute left-full top-1/2 z-30 w-60 -translate-y-1/2 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-2 text-left shadow-lg">
      <div className="text-[12px] leading-snug text-[var(--v2-text)]" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{prompt.text}</div>
      {prompt.ts !== undefined && <div className="mt-1 text-[10.5px] text-[var(--v2-muted)]">{when(prompt.ts)}</div>}
      {files.length > 0 && (
        <div className="mt-1 text-[10.5px] text-[var(--v2-muted)]">
          Changed {files.length} {files.length === 1 ? "file" : "files"}
          <div className="mt-0.5 flex flex-wrap gap-1">
            {files.slice(0, 5).map(f => (
              <button key={f} type="button" title={f} onClick={() => onOpenChange(f)}
                className="rounded border border-[var(--v2-edge-2)] px-1 py-0.5 text-[10px] text-[var(--v2-text)] hover:border-[var(--v2-accent)]">
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
  const { prompts, active, jump } = useTimeline(root);
  const [shown, setShown] = useState<number | null>(null);
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
    <nav aria-label="Prompt timeline" className="flex w-5 shrink-0 flex-col items-center justify-center self-stretch overflow-y-auto py-2">
      {prompts.map((p, i) => (
        <div key={p.id} className="relative flex h-5 w-full shrink-0 items-center justify-center"
          onMouseEnter={() => setShown(i)} onMouseLeave={() => setShown(null)}
          onFocus={() => { setShown(i); setRove(i); }}
          onBlur={e => {
            // SAFETY: relatedTarget is the element taking focus next; Node is its DOM type here.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setShown(null);
          }}>
          <button type="button" ref={el => { ticks.current[i] = el; }} aria-label={tickLabel(i, prompts.length, p.text)}
            aria-current={i === active ? "true" : undefined} tabIndex={i === tabbable ? 0 : -1}
            onClick={() => jump(p.id)} onKeyDown={e => onKey(e, i)}
            className="flex h-full min-h-5 w-full items-center justify-center">
            <span aria-hidden className={`block h-[2px] rounded-full ${i === active ? "w-[18px] bg-[var(--v2-accent)]" : "w-3.5 bg-[var(--v2-muted)]"}`} />
          </button>
          {shown === i && <Card prompt={p} onOpenChange={onOpenChange} />}
        </div>
      ))}
    </nav>
  );
}
