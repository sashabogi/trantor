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

/** "claude:trantor-duty" → "trantor-duty"; the part a person reads. */
export function seatLabel(name: string): string {
  const i = name.lastIndexOf(":");
  return i >= 0 ? name.slice(i + 1) : name;
}

/** codex-8 → C8, orchestrator → OR, trantor-duty → TD. */
export function monogram(name: string): string {
  const label = seatLabel(name).trim();
  const seat = /^([a-z])[a-z]*-?(\d+)$/i.exec(label);
  if (seat) return `${seat[1]}${seat[2]}`.toUpperCase();
  const parts = label.split(/[-_\s.]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (label.slice(0, 2) || "?").toUpperCase();
}

export function seatPalette(name: string): SeatPalette {
  const key = name.toLowerCase();
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
