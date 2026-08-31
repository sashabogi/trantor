import { HANDOFF_WARN_FRAC } from "./streaming";

export const HANDOFF_COUNTDOWN_MS = 10_000;

export type HandoffCountdown = {
  visible: boolean;
  expired: boolean;
  remainingMs: number;
  remainingSec: number;
};

export function bannerCountdown(
  frac: number | null,
  armedAt: number | null,
  now: number,
): HandoffCountdown {
  const hidden: HandoffCountdown = {
    visible: false,
    expired: false,
    remainingMs: HANDOFF_COUNTDOWN_MS,
    remainingSec: HANDOFF_COUNTDOWN_MS / 1000,
  };
  if (frac === null || frac < HANDOFF_WARN_FRAC || armedAt === null) return hidden;
  const elapsed = Math.max(0, now - armedAt);
  const remainingMs = Math.max(0, HANDOFF_COUNTDOWN_MS - elapsed);
  return {
    visible: true,
    expired: elapsed >= HANDOFF_COUNTDOWN_MS,
    remainingMs,
    remainingSec: Math.ceil(remainingMs / 1000),
  };
}
