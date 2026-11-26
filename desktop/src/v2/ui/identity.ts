// Monograms and colours for seats and projects, matched to the artboard swatches (#v2-F).
import { dictGet } from "../../shared/dict";

export type Presence = "working" | "needs-you" | "ready" | "offline";

export const PRESENCE_COLOR = {
  working: "var(--v2-accent)",
  "needs-you": "var(--v2-warn)",
  ready: "var(--v2-ok)",
  offline: "var(--v2-track)",
} as const satisfies Record<Presence, string>;

export const PRESENCE_LABEL = {
  working: "working",
  "needs-you": "needs you",
  ready: "ready",
  offline: "offline",
} as const satisfies Record<Presence, string>;

/** #14351: one state language for tabs, tiles, rows and the hover card. Needs-you overrides every other state. */
export type SeatState = "working" | "needs" | "ready" | "waiting" | "idle" | "offline";

export type SeatStateInput = { presence: Presence; words: string; isOrchestrator?: boolean; target?: { status?: string } };

export function seatState(seat: Pick<SeatStateInput, "presence" | "words">): SeatState {
  if (seat.presence === "needs-you") return "needs";
  if (seat.presence === "offline") return "offline";
  if (seat.presence === "working") return "working";
  const w = seat.words.toLowerCase();
  if (w.startsWith("waiting")) return "waiting";
  if (w === "idle" || w === "finished") return "idle";
  // a parked or stalled seat cannot take work: it sleeps rather than giving a thumbs up (#14365)
  if (/^(parked|stalled|cut at)/.test(w)) return "idle";
  return "ready";
}

export const STATE_WORD = {
  working: "working", needs: "needs you", ready: "ready", waiting: "waiting", idle: "idle", offline: "offline",
} as const satisfies Record<SeatState, string>;

const STATE_COLOR = {
  working: "var(--v2-accent)", needs: "var(--v2-warn)", ready: "var(--v2-ok)", waiting: "var(--v2-proposal)",
} as const;

/** Props for the 8px dot: solid for working, needs, ready and waiting (working pulses), a hollow 1px faint ring for idle and offline. */
export function stateDot(state: SeatState) {
  if (state === "idle" || state === "offline") return { className: "", style: { background: "transparent", boxShadow: "inset 0 0 0 1px var(--v2-faint)" } };
  return { className: state === "working" ? "v2-pulse" : "", style: { background: STATE_COLOR[state] } };
}

/** A short human line for what the seat is doing: "running tests", "needs you: approve push", "ready", "waiting on glm-5", "idle". */
export function activityLine(seat: SeatStateInput, opts: { needs?: string; waitingOn?: string } = {}): string {
  const state = seatState(seat);
  if (state === "needs") return opts.needs ? `needs you: ${opts.needs}` : "needs you";
  if (state === "waiting") return opts.waitingOn ? `waiting on ${opts.waitingOn}` : seat.words;
  if (state === "working") {
    const doing = (seat.target?.status ?? "").replace(/^working\s*·?\s*/i, "").trim();
    if (/^card\s+\d+/i.test(doing)) return `working on ${doing}`;
    return doing || (seat.words === "working" ? "working" : seat.words);
  }
  if (seat.isOrchestrator && (state === "ready" || state === "idle")) return "you";
  return state === "offline" ? "offline" : seat.words;
}

export type SeatPalette = { bg: string; fg: string };

const SEAT_PALETTES: [RegExp, SeatPalette][] = [
  [/orchestrator|claude|opus|sonnet|anthropic/, { bg: "#3A2A24", fg: "#E39A7E" }],
  [/codex|openai|gpt/, { bg: "#1E2A26", fg: "#7FD8B8" }],
  [/glm|zai|zhipu/, { bg: "#1E2338", fg: "#A9B8FF" }],
  [/kimi|moonshot/, { bg: "#2A2238", fg: "#CDB1FF" }],
  [/deepseek/, { bg: "#1C2238", fg: "#8FA4F0" }],
  [/qwen/, { bg: "#1F2A3A", fg: "#8AC4FF" }],
];
const NEUTRAL: SeatPalette = { bg: "#2A2E36", fg: "#E7E9EC" };

/** Match the session's machine component exactly once the local identity is available. */
export function isHostSession(session: string, machineId?: string): boolean {
  const head = session.split(":")[0];
  return machineId ? head === machineId : head.toLowerCase().startsWith("macbook");
}

/** Legacy display names are recognized only until the machine identity arrives. */
export function isHostIdentity(name: string, machineId?: string): boolean {
  return machineId ? isHostSession(name, machineId) : /^(macbook|imac|mac[-.]|.*\.local$)|@/i.test(name.split(":")[0]);
}

/** The seat a person reads from a session id `<seat>:<project>`: "codex-8:trantor" → "codex-8",
 *  a host session → "orchestrator", the duty seat → its job name (#13984 drill: every avatar read TR). */
export function seatLabel(name: string, machineId?: string): string {
  const i = name.indexOf(":");
  if (i < 0) return name;
  const head = name.slice(0, i), tail = name.slice(i + 1);
  if (/-duty$|^fleet$/.test(tail) && !/\d/.test(head)) return tail === "fleet" ? "trantor-duty" : tail;
  if (isHostIdentity(name, machineId)) return "orchestrator";
  if (!/\d/.test(head) && /^[a-z]+-\d+$/i.test(tail)) return tail;
  return head;
}

/** The agent a seat runs: a persona is "<agent>" or "<agent>-<n>", so "glm-5:trantor" → "glm" (#14062).
 *  Swap must never offer a seat the agent it already runs. */
export function seatAgent(session: string): string {
  return session.split(":")[0].replace(/-\d+$/, "");
}

/** codex-8 → C8, orchestrator → OR, trantor-duty → TD. */
export function monogram(name: string, machineId?: string): string {
  const label = seatLabel(name, machineId).trim();
  const seat = /^([a-z])[a-z]*-?(\d+)$/i.exec(label);
  if (seat) return `${seat[1]}${seat[2]}`.toUpperCase();
  const parts = label.split(/[-_\s.]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (label.slice(0, 2) || "?").toUpperCase();
}

export function seatPalette(name: string, machineId?: string): SeatPalette {
  const key = `${seatLabel(name, machineId)} ${name}`.toLowerCase();
  for (const [re, palette] of SEAT_PALETTES) if (re.test(key)) return palette;
  return NEUTRAL;
}

const PROJECT_GRADIENTS: [string, string][] = [
  ["#4C6BC8", "#2B3A5C"], ["#8A5BD1", "#3B2E52"], ["#C77D4A", "#3A2F28"],
  ["#B8A04A", "#3A3420"], ["#3E9E7E", "#1F3A31"], ["#5A6CD1", "#23284A"],
  ["#6BA04A", "#26381C"], ["#4AB8A8", "#1C3835"], ["#4A8FB8", "#1F3442"],
];
const PINNED_GRADIENT = { trantor: 0, "crebral-cortex": 1, "trantor-duty": 2 } as const satisfies Record<string, number>;

export function projectGradient(name: string): string {
  let idx: number | undefined = dictGet(PINNED_GRADIENT, name);
  if (idx === undefined) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    idx = h % PROJECT_GRADIENTS.length;
  }
  const [a, b] = PROJECT_GRADIENTS[idx];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

const MODEL_BRANDS = {
  gpt: "GPT",
  codex: "Codex",
  glm: "GLM",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  gemini: "Gemini",
} as const;

export function modelLabel(id: string): string {
  const bare = id.slice(id.lastIndexOf("/") + 1);
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(bare);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1);
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  }
  const matched = /^(gpt|codex|glm|kimi|deepseek|qwen|gemini)[-_]?(.+)$/i.exec(bare);
  if (!matched) return id;
  const brand = dictGet(MODEL_BRANDS, matched[1].toLowerCase());
  if (!brand) return id;
  const detail = matched[2].split(/[-_]/).filter(Boolean).map(part => {
    if (/^v\d/i.test(part) || /^\d/.test(part)) return part.toUpperCase();
    return part[0].toUpperCase() + part.slice(1);
  }).join(" ");
  return detail ? `${brand} ${detail}` : id;
}

/** The brand dot beside a model name in the composer and the plans bar. */
export function modelHue(model: string): string {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return "#D97757";
  if (/gpt|codex|openai|o\d/.test(m)) return "#7FD8B8";
  if (/glm/.test(m)) return "#A9B8FF";
  if (/kimi|moonshot/.test(m)) return "#CDB1FF";
  if (/deepseek/.test(m)) return "#5B7BE8";
  if (/qwen/.test(m)) return "#8AA8FF";
  return "#C4C8CE";
}

/** The agent brand a model id belongs to, for an avatar whose name does not say (#13984 drill). */
export function brandOfModel(model: string): string | undefined {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return "claude";
  if (/gpt|codex|openai|^o\d/.test(m)) return "codex";
  if (/glm|zai/.test(m)) return "glm";
  if (/kimi|moonshot/.test(m)) return "kimi";
  if (/deepseek/.test(m)) return "deepseek";
  if (/qwen/.test(m)) return "qwen";
  if (/gemini/.test(m)) return "gemini";
  return undefined;
}
