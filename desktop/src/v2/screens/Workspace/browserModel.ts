// The browser contract's client shapes and the pure calls the Browser tab renders from (#14489, #14505).
// Field names are the contract's wire names (snake_case), so the tab and the Rust core never translate.
export type BrowserRect = { x: number; y: number; w: number; h: number };

export type BrowserDriver = { session: string; label: string; action: string; since: number };

export type BrowserState = {
  project: string;
  url: string | null;
  title: string;
  loading: boolean;
  can_back: boolean;
  can_forward: boolean;
  popped_out: boolean;
  driver: BrowserDriver | null;
  held_by_user: boolean;
};

export type BrowserAsk = { project: string; id: string; session: string; label: string; host: string };

export type BrowserAskChoice = "once" | "site" | "deny";

/** One thing an agent did with the browser, newest last (browser_steps). */
export type BrowserStep = { session: string; label: string; action: string; at: number; ok: boolean };

/** What a browser command carries besides its project: exactly the fields the command names. */
export type BrowserArgs = {
  url?: string | null;
  rect?: BrowserRect;
  visible?: boolean;
  id?: string;
  choice?: BrowserAskChoice;
};

export const BROWSER_STATE_EVENT = "browser://state";
export const BROWSER_ASK_EVENT = "browser://ask";
export const BROWSER_REVEAL_EVENT = "browser://reveal";

/** Every project starts here; the first browser://state event or browser_state read replaces it. */
export const EMPTY_BROWSER_STATE: BrowserState = {
  project: "", url: null, title: "", loading: false, can_back: false, can_forward: false,
  popped_out: false, driver: null, held_by_user: false,
};

/** One dev server or build preview the empty state offers to open. */
export type BrowserPreview = { url: string; note: string; running: boolean };

/** The line under the address bar (artboard section B): nobody, an agent, or you holding it. */
export type DrivingLine =
  | { kind: "agent"; label: string; action: string }
  | { kind: "held"; label: string | null };

export function drivingLine(state: BrowserState): DrivingLine | null {
  if (state.held_by_user) return { kind: "held", label: state.driver?.label ?? null };
  if (state.driver) return { kind: "agent", label: state.driver.label, action: state.driver.action };
  return null;
}

// A schemed URL passes through, a bare host (localhost:5173, github.com, host:port/path) gains http://,
// anything with spaces stays as typed: search routing is a later browser's call, not B2's.
const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_HOST = /^[\w.-]+(:\d+)?([/?#].*)?$/;

/** What the address bar sends on Enter: normalized, never empty. */
export function addressToUrl(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || SCHEMED.test(trimmed)) return trimmed;
  return BARE_HOST.test(trimmed) ? `http://${trimmed}` : trimmed;
}

/** The placeholder's place in the window, in logical pixels relative to the main window's content. */
export function rectOf(el: HTMLElement): BrowserRect {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}
