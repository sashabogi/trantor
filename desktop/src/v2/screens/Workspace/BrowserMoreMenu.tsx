// The More menu (artboard F1, #14516): everything that is not a toolbar button — pages, zoom, the
// user agent list, find, devices, history, favorites, permissions, clear data, the chat actions,
// open external. "Browser settings" stays hidden until Settings gains a Browser section.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Camera, ChevronRight, MousePointer2, MoreHorizontal, Minus, Plus } from "lucide-react";
import { ChoiceRow } from "../../ui/ComposerMenu";
import { IconButton } from "../../ui/IconButton";
import { Kbd } from "../../ui/Kbd";
import { type BrowserPanelTab } from "./BrowserPanel";
import { USER_AGENTS, zoomPercent, zoomStep, type BrowserState } from "./browserModel";

const MENU = "absolute right-0 top-full z-30 mt-1 w-72 rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1 shadow-lg";
const RULE = "my-1 h-px bg-[var(--v2-edge)]";
const ACTION = "v2-hover flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-v2-body text-[var(--v2-text)] disabled:opacity-45";
const ZOOM_BUTTON = "v2-hover inline-flex h-[22px] w-6 items-center justify-center rounded-md border border-[var(--v2-edge-2)] bg-transparent text-[var(--v2-text)]";
const QUIET = "v2-hover inline-flex h-[22px] shrink-0 items-center rounded-md border-0 bg-transparent px-1.5 text-v2-small text-[var(--v2-muted)]";

/** One menu row: label, optional shortcut hint, optional trailing node. */
function ActionRow({ label, kbd, title, disabled, onPick, trailing }: {
  label: string;
  kbd?: string;
  title?: string;
  disabled?: boolean;
  onPick: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" disabled={disabled} title={title} onClick={onPick} className={ACTION}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  );
}

export function BrowserMoreMenu({ open, onOpen, onClose, state, onNewPage, onClosePage, onZoom, onUserAgent,
  onFind, onDevices, onPanel, onFavorite, onClearStorage, onScreenshot, onPickElement, onOpenExternal }: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  state: BrowserState;
  onNewPage: () => void;
  onClosePage: () => void;
  onZoom: (level: number | null) => void;
  onUserAgent: (preset: string) => void;
  onFind: () => void;
  onDevices: () => void;
  onPanel: (tab: BrowserPanelTab) => void;
  onFavorite: () => void;
  onClearStorage: () => void;
  onScreenshot: () => void;
  onPickElement: () => void;
  onOpenExternal: () => void;
}) {
  const [view, setView] = useState<"main" | "ua">("main");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const root = useRef<HTMLSpanElement | null>(null);

  // Outside pointer and Esc close the whole menu; the zoom row keeps it open for repeated nudges.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent): void => { if (e.target instanceof Node && !root.current?.contains(e.target)) onClose(); };
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", esc); };
  }, [open, onClose]);
  useEffect(() => { if (!open) { setView("main"); setConfirmingClear(false); } }, [open]);

  const hasPage = state.url !== null;

  return (
    <span ref={root} className="relative inline-flex">
      <IconButton label="More" title="More browser actions" aria-haspopup="menu" aria-expanded={open} size={28}
        onClick={() => { if (open) onClose(); else onOpen(); }}
        style={{ background: open ? "var(--v2-raised)" : undefined }}>
        <MoreHorizontal size={14} aria-hidden />
      </IconButton>
      {open && (
        <div role="menu" aria-label="More browser actions" className={MENU}>
          {view === "ua" ? (
            <>
              <div className="px-2.5 pb-1 pt-1.5 text-v2-small font-semibold uppercase tracking-wider text-[var(--v2-muted)]">User agent</div>
              {USER_AGENTS.map(u => (
                <ChoiceRow key={u} choice={{ value: u, label: u }} current={u === state.user_agent}
                  onPick={() => { onUserAgent(u); onClose(); }} />
              ))}
              <div className={RULE} />
              <ActionRow label="Back" onPick={() => setView("main")} />
            </>
          ) : (
            <>
              <ActionRow label="New page" kbd="⌘T" onPick={() => { onNewPage(); onClose(); }} />
              <ActionRow label="Close page" kbd="⌘W" title={state.active_page ? "Close the open page" : "Nothing to close"}
                disabled={!state.active_page} onPick={() => { onClosePage(); onClose(); }} />
              <div className={RULE} />
              <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 text-v2-body text-[var(--v2-text)]">Zoom</span>
                <button type="button" aria-label="Zoom out" title="Zoom out" className={ZOOM_BUTTON} onClick={() => onZoom(zoomStep(state.zoom, -1))}><Minus size={12} aria-hidden /></button>
                <span className="v2-mono w-10 shrink-0 text-center text-v2-small text-[var(--v2-text)]">{zoomPercent(state.zoom)}</span>
                <button type="button" aria-label="Zoom in" title="Zoom in" className={ZOOM_BUTTON} onClick={() => onZoom(zoomStep(state.zoom, 1))}><Plus size={12} aria-hidden /></button>
                <button type="button" className={QUIET} onClick={() => onZoom(null)}>Reset</button>
              </div>
              <ActionRow label="User agent" title="Choose which browser the page is told about"
                onPick={() => setView("ua")}
                trailing={<span className="flex min-w-0 shrink-0 items-center gap-1 text-v2-small text-[var(--v2-muted)]"><span className="max-w-[120px] truncate">{state.user_agent}</span><ChevronRight size={10} aria-hidden /></span>} />
              <div className={RULE} />
              <ActionRow label="Find in page" kbd="⌘F" onPick={() => { onFind(); onClose(); }} />
              <ActionRow label="Device emulation" kbd="⇧⌘M" onPick={() => { onDevices(); onClose(); }} />
              <div className={RULE} />
              <ActionRow label="History" onPick={() => { onPanel("history"); }} />
              <ActionRow label="Favorites" onPick={() => { onPanel("favorites"); }} />
              <ActionRow label="Add this page to favorites" kbd="⌘D" title={hasPage ? "Favorite (or unfavorite) the open page" : "Nothing open to favorite"}
                disabled={!hasPage} onPick={() => { onFavorite(); onClose(); }} />
              <div className={RULE} />
              <ActionRow label="Site permissions" onPick={() => { onPanel("permissions"); }} />
              {confirmingClear ? (
                <div role="group" aria-label="Clear browsing data" className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 text-v2-small leading-snug text-[var(--v2-text-2)]">Sign this project's browser out of everything?</span>
                  <button type="button" className="v2-hover inline-flex h-[22px] shrink-0 items-center rounded-md border border-[var(--v2-bad-edge)] bg-transparent px-2 text-v2-small font-medium text-[var(--v2-text)]"
                    onClick={() => { onClearStorage(); onClose(); }}>Clear</button>
                  <button type="button" className={QUIET} onClick={() => setConfirmingClear(false)}>Keep</button>
                </div>
              ) : (
                <ActionRow label="Clear browsing data" title="Cookies, storage and cache of this project's browser" onPick={() => setConfirmingClear(true)} />
              )}
              <ActionRow label="Screenshot to chat" title="Send a screenshot to chat" onPick={() => { onScreenshot(); onClose(); }} trailing={<Camera size={12} aria-hidden className="shrink-0 text-[var(--v2-muted)]" />} />
              <ActionRow label="Pick an element for chat" title="Pick an element and add it to chat" onPick={() => { onPickElement(); onClose(); }} trailing={<MousePointer2 size={12} aria-hidden className="shrink-0 text-[var(--v2-muted)]" />} />
              <ActionRow label="Open in your default browser" title={hasPage ? "Open the current page in your default browser" : "Nothing open to open"}
                disabled={!hasPage} onPick={() => { onOpenExternal(); onClose(); }} />
              {/* "Browser settings" joins this menu when Settings grows a Browser section (#14516). */}
            </>
          )}
        </div>
      )}
    </span>
  );
}
