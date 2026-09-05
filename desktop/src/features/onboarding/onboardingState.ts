// Onboarding — pure step logic. What state.json says (shown/closed) and whether each step's own
// condition is already satisfied live here, apart from the wizard's rendering, so both are
// testable without mounting anything.
import type { ProviderStatus } from "../settings/providers/providerStatus";

export type OnboardingState = {
  flowVersion: number;
  closedAt: number | null;
  lastCompletedStep: string | null;
};

export const ONBOARDING_STEPS = ["providers", "identity", "autonomy", "project"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** null means "not read yet" — never show a flash of the wizard before the first read lands. */
export function shouldShowOnboarding(state: OnboardingState | null): boolean {
  return state !== null && state.closedAt === null;
}

export function isProvidersStepSatisfied(providers: ProviderStatus[]): boolean {
  return providers.some(p => p.state === "connected");
}

export function isIdentityStepSatisfied(hasHubPin: boolean): boolean {
  return hasHubPin;
}

// Mirrors lib/autonomy.mjs DEFAULTS — the CLI's `overridden` list is empty at global scope by
// design (nothing to mark "overridden" relative to itself), so "already chosen" is read the same
// way a hand-edited autonomy.json would be: does anything differ from the shipped defaults.
export const AUTONOMY_DEFAULTS = {
  harness: "prompt",
  commit: false,
  push: false,
  deploy: false,
  swapDeadSeat: true,
  retryFailedTurn: true,
  baton: "ask",
} as const;

export function isAutonomyStepSatisfied(resolved: Record<string, unknown>): boolean {
  return (Object.keys(AUTONOMY_DEFAULTS) as Array<keyof typeof AUTONOMY_DEFAULTS>)
    .some(key => resolved[key] !== AUTONOMY_DEFAULTS[key]);
}

export function isProjectStepSatisfied(projectCount: number): boolean {
  return projectCount > 0;
}
