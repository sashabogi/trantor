// The Browser tab: the project's shared page host — address bar, the line that says who is driving,
// and the placeholder the native webview covers (#14489 contract, #14505). Rust lands as B1; every
// action is one Tauri command and every change arrives as a browser://state event.
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft, ArrowRight, Camera, ChevronDown, ChevronRight, ExternalLink, Lock, Maximize2, Minimize2, MousePointer2, PictureInPicture2, RotateCw,
} from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { useEscape } from "../../ui/useEscape";
import { addressToUrl, drivingLine, rectOf, type BrowserPreview } from "./browserModel";
import { useBrowser } from "./useBrowser";

const LINE_BUTTON = "v2-hover inline-flex h-[22px] shrink-0 items-center rounded-md border border-[var(--v2-edge-2)] bg-transparent px-2 text-v2-small font-medium text-[var(--v2-text)]";
const LINE_BUTTON_QUIET = "v2-hover inline-flex h-[22px] shrink-0 items-center rounded-md border-0 bg-transparent px-2 text-v2-small text-[var(--v2-muted)]";

export function BrowserTab({ project, maximized = false, onMaximize, previews = [], onScreenshot, onPickElement }: {
  project: string;
  /** Esc restores a maximized browser from anywhere in the tab. */
  maximized?: boolean;
  onMaximize: (maximized: boolean) => void;
  /** Dev servers and build previews the empty state offers; B2 has no source for them yet. */
  previews?: BrowserPreview[];
  // #14505: the chat actions land with B3; until then the buttons are inert on purpose.
  onScreenshot?: () => void;
  onPickElement?: () => void;
}) {
  const { state, ask, read, steps, commands } = useBrowser(project);
  const [stepsOpen, setStepsOpen] = useState(false);
  useEscape(() => onMaximize(false), maximized);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const openedRef = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? state.url ?? "";
  const line = drivingLine(state);

  // The region is where the native page sits: once the state is known, open the browser into it
  // once, then follow every resize (a column drag, a maximize) with the fresh rect. Moves that
  // resize nothing re-run this when the pop-out returns the page or the column maximizes.
  useEffect(() => {
    const el = regionRef.current;
    if (!read || !el || state.popped_out) return;
    if (!openedRef.current) {
      openedRef.current = true;
      commands.open(rectOf(el));
    }
    // The native page does not move with the DOM: a banner or the seat strip shifting the region
    // without resizing it left the page covering the address bar. Check every frame, send on change.
    let last = "";
    const send = () => {
      const r = rectOf(el);
      const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`;
      if (key === last) return;
      last = key;
      commands.setRect(r);
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    let frame = requestAnimationFrame(function tick() { send(); frame = requestAnimationFrame(tick); });
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, [commands, read, state.popped_out, maximized]);

  // The native page is an OS view above this markup, so it shows only while a page is open in the
  // tab; the unmount cleanup hides it whenever the tab or the Workspace stops showing the browser.
  useEffect(() => {
    commands.setVisible(state.url !== null && !state.popped_out);
    return () => commands.setVisible(false);
  }, [commands, state.url, state.popped_out]);

  const submitAddress = () => {
    const url = addressToUrl(shown);
    if (url !== "") { commands.navigate(url); setDraft(null); }
  };
  const openExternal = () => { if (state.url) void openUrl(state.url).catch(() => {}); };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--v2-edge)] px-2 py-1.5">
        <IconButton label="Back" title={state.can_back ? "Go back one page" : "Nothing to go back to"} size={28} disabled={!state.can_back} onClick={commands.back}><ArrowLeft size={14} aria-hidden /></IconButton>
        <IconButton label="Forward" title={state.can_forward ? "Go forward one page" : "Nothing to go forward to"} size={28} disabled={!state.can_forward} onClick={commands.forward}><ArrowRight size={14} aria-hidden /></IconButton>
        <IconButton label="Reload" title="Reload the page" size={28} onClick={commands.reload}><RotateCw size={14} aria-hidden /></IconButton>
        <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--v2-edge)] bg-[var(--v2-side)] px-2.5">
          {state.url !== null && <Lock size={12} aria-hidden className="shrink-0 text-[var(--v2-ok)]" />}
          <input aria-label="Address" placeholder="Type an address or search" value={shown}
            className="v2-mono min-w-0 flex-1 border-0 bg-transparent text-v2-small text-[var(--v2-text-2)] outline-none"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submitAddress(); } }} />
        </label>
        <IconButton label="Screenshot to chat" title="Send a screenshot to chat" size={28} onClick={() => onScreenshot?.()}><Camera size={14} aria-hidden /></IconButton>
        <IconButton label="Pick an element for chat" title="Pick an element and add it to chat" size={28} onClick={() => onPickElement?.()}><MousePointer2 size={14} aria-hidden /></IconButton>
        <IconButton label="Open in your default browser" title="Open in your default browser" size={28} disabled={state.url === null} onClick={openExternal}><ExternalLink size={14} aria-hidden /></IconButton>
        <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--v2-edge-2)]" />
        {maximized
          ? <IconButton label="Restore" title="Restore · Esc" size={28} onClick={() => onMaximize(false)}><Minimize2 size={14} aria-hidden /></IconButton>
          : <IconButton label="Maximize the browser" title="Maximize (fills the Workspace, Esc to restore)" size={28} onClick={() => onMaximize(true)}><Maximize2 size={14} aria-hidden /></IconButton>}
        <IconButton label="Pop out into its own window" title="Pop out into its own window" size={28} onClick={commands.popOut}><PictureInPicture2 size={14} aria-hidden /></IconButton>
      </div>

      {ask ? (
        <div className="flex min-h-[38px] shrink-0 flex-wrap items-center gap-2 border-b border-[var(--v2-warn-edge)] bg-[var(--v2-warn-panel)] px-2.5 py-1.5">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--v2-warn)]" />
          <span className="min-w-0 flex-1 text-v2-body text-[var(--v2-text-2)]">
            <span className="font-medium text-[var(--v2-text)]">{ask.label}</span> wants to open <span className="v2-mono text-[var(--v2-text)]">{ask.host}</span>
          </span>
          <button type="button" className={LINE_BUTTON} onClick={() => commands.answer(ask.id, "once")}>Allow once</button>
          <button type="button" className={LINE_BUTTON} onClick={() => commands.answer(ask.id, "site")}>Allow this site</button>
          <button type="button" className={LINE_BUTTON_QUIET} onClick={() => commands.answer(ask.id, "deny")}>Not now</button>
        </div>
      ) : line && (line.kind === "agent" ? (
        <div className="v2-breathe flex h-[30px] shrink-0 items-center gap-2 border-b border-[var(--v2-accent-edge)] bg-[var(--v2-info-soft)] px-2.5">
          <span aria-hidden className="v2-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--v2-accent)]" />
          <span className="min-w-0 flex-1 truncate text-v2-body text-[var(--v2-text-2)]">
            <span className="font-medium text-[var(--v2-text)]">{line.label}</span> is using the browser · {line.action}
          </span>
          <button type="button" className={LINE_BUTTON} onClick={commands.takeOver}>Take over</button>
        </div>
      ) : (
        <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--v2-text-2)]" />
          <span className="min-w-0 flex-1 truncate text-v2-body text-[var(--v2-text-2)]">
            You have the browser{line.label ? <> · <span className="font-medium text-[var(--v2-text)]">{line.label}</span> is paused, waiting</> : null}
          </span>
          <button type="button" className={LINE_BUTTON} onClick={commands.giveBack}>Give back</button>
        </div>
      ))}

      <div ref={regionRef} data-testid="browser-region" className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--v2-sunken)]">
        {state.popped_out ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <div className="text-v2-base text-[var(--v2-muted)]">Open in its own window</div>
            <button type="button" className={LINE_BUTTON} onClick={commands.popOut}>Show</button>
          </div>
        ) : state.url === null ? (
          <div className="flex flex-col gap-4 p-7">
            <div className="text-v2-title font-semibold">Nothing open</div>
            <p className="m-0 max-w-[560px] text-v2-body leading-relaxed text-[var(--v2-muted)]">
              Links you click in chat open here, and so does the dev server when a seat starts one. Type an address above to browse yourself.
            </p>
            {previews.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="text-v2-micro font-semibold uppercase tracking-wider text-[var(--v2-muted)]">Previews in this project</div>
                {previews.map(p => (
                  <button key={p.url} type="button" title={`Open ${p.url}`} onClick={() => commands.navigate(addressToUrl(p.url))}
                    className="v2-hover flex h-[34px] items-center gap-2.5 rounded-lg border border-dashed border-[var(--v2-edge-2)] bg-transparent px-2.5 text-left text-v2-body text-[var(--v2-text-2)]">
                    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.running ? "bg-[var(--v2-ok)]" : "bg-[var(--v2-faint)]"}`} />
                    <span className="v2-mono shrink-0">{p.url}</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--v2-muted)]">{p.note}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div aria-label="The page" className="min-h-0 flex-1" />
        )}
      </div>

      {steps.length > 0 && !state.popped_out && (
        <div className="flex shrink-0 flex-col border-t border-[var(--v2-edge)]">
          <button type="button" aria-expanded={stepsOpen} onClick={() => setStepsOpen(o => !o)}
            className="v2-hover flex h-[30px] items-center gap-2 border-0 bg-transparent px-2.5 text-left text-v2-small text-[var(--v2-muted)]">
            {stepsOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            Steps · {steps.length}
          </button>
          {stepsOpen && (
            <ol className="v2-mono m-0 flex max-h-40 list-none flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5 pl-7 text-v2-small text-[var(--v2-muted)]">
              {steps.slice(-20).map((step, i) => (
                <li key={`${step.at}-${i}`}>
                  <span className="text-[var(--v2-text-2)]">{step.label}</span> {step.action}{step.ok ? "" : " · failed"}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
