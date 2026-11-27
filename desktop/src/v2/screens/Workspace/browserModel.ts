// The browser contract's client shapes and the pure calls the Browser tab renders from (#14489, #14505, #14516).
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
  // Wave 2 (#14516): the page set, which page is shown, and the B5 controls' live values.
  pages: BrowserPage[];
  active_page: string;
  zoom: number;
  user_agent: string;
  emulation: BrowserDevice | null;
};

/** One page of the strip (BrowserState.pages): url is "" while a page sits on nothing. */
export type BrowserPage = { id: string; url: string; title: string; loading: boolean; driver: BrowserDriver | null; restored?: boolean };

/** The contract's Device { name, w, h, mobile }; emulation letterboxes the page at this size. */
export type BrowserDevice = { name: string; w: number; h: number; mobile: boolean };

/** kind "evaluate": an agent asks to run a script on the page, not to open a new host. */
export type BrowserAsk = { project: string; id: string; session: string; label: string; host: string; kind?: "evaluate" };

export type BrowserAskChoice = "once" | "site" | "deny";

/** One thing an agent did with the browser, newest last (browser_steps). */
export type BrowserStep = { session: string; label: string; action: string; at: number; ok: boolean };

/** One row of browser_history: where this project's browser has been, newest first. */
export type BrowserHistoryEntry = { url: string; title: string; at: number };

export type BrowserFavorite = { url: string; title: string };

/** One host the agents of this project may open without asking (browser_permissions). */
export type BrowserPermission = { host: string; rule: "site" };

/** What a browser command carries besides its project: exactly the fields the command names. */
export type BrowserArgs = {
  url?: string | null;
  rect?: BrowserRect;
  visible?: boolean;
  id?: string;
  choice?: BrowserAskChoice;
  page?: string;
  level?: number | null;
  text?: string;
  backwards?: boolean;
  preset?: string | null;
  device?: BrowserDevice | null;
  title?: string;
  host?: string;
};

export const BROWSER_STATE_EVENT = "browser://state";
export const BROWSER_ASK_EVENT = "browser://ask";
export const BROWSER_REVEAL_EVENT = "browser://reveal";

/** Every project starts here; the first browser://state event or browser_state read replaces it. */
export const EMPTY_BROWSER_STATE: BrowserState = {
  project: "", url: null, title: "", loading: false, can_back: false, can_forward: false,
  popped_out: false, driver: null, held_by_user: false,
  pages: [], active_page: "", zoom: 1, user_agent: "Safari", emulation: null,
};

/** The user agent list the More menu offers (artboard F1); the name goes to browser_set_user_agent. */
// the presets the Rust core accepts (anything else is bad_request)
export const USER_AGENTS: readonly string[] = ["Safari", "Chrome", "Firefox", "iPhone", "iPad", "Android"];

/** The device presets the contract fixes, shown as the device bar's pills (artboard F2). */
export const DEVICE_PRESETS: readonly BrowserDevice[] = [
  { name: "iPhone 15", w: 393, h: 852, mobile: true },
  { name: "iPhone SE", w: 375, h: 667, mobile: true },
  { name: "Pixel 8", w: 412, h: 915, mobile: true },
  { name: "iPad", w: 820, h: 1180, mobile: true },
  { name: "Laptop", w: 1280, h: 800, mobile: false },
  { name: "Desktop", w: 1920, h: 1080, mobile: false },
];

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

/** browser_zoom clamps server-side; the menu clamps the same way so the row never shows a lie. */
export function clampZoom(level: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(level * 10) / 10));
}

/** One nudge of the menu's − / + buttons, clamped. */
export function zoomStep(level: number, direction: 1 | -1): number {
  return clampZoom(level + direction * ZOOM_STEP);
}

/** The zoom row's label: 110%, 85%. */
export function zoomPercent(level: number): string {
  return `${Math.round(level * 100)}%`;
}

/** The page strip and the history rows name a page by its host, not its whole url. */
export function hostOf(url: string): string {
  const rest = SCHEMED.test(url) ? url.slice(url.indexOf("//") + 2) : url;
  return rest.split("/")[0] ?? "";
}

/** The page strip's name for a page: its url without the scheme (artboard D), or "blank". */
export function pageLabel(page: BrowserPage): string {
  return SCHEMED.test(page.url) ? page.url.slice(page.url.indexOf("//") + 2) || "blank" : page.url || "blank";
}

/** History rows say how long ago: "now", "2m", "1h", "3d". `at` is epoch seconds (browser_history). */
export function ago(at: number, now: number = Date.now() / 1000): string {
  const seconds = Math.max(0, Math.round(now - at));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

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
