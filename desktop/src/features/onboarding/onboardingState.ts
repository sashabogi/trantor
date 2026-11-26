// Onboarding — pure step logic. What state.json says (shown/closed) and whether each step's own
// condition is already satisfied live here, apart from the wizard's rendering, so both are
// testable without mounting anything.
import type { ProviderStatus } from "../settings/providers/providerStatus";
import type { SetupReport } from "../../shared/api/client";

export type OnboardingState = {
  flowVersion: number;
  closedAt: number | null;
  lastCompletedStep: string | null;
};

export const ONBOARDING_STEPS = ["setup", "providers", "identity", "autonomy", "project"] as const;
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

/** The shape of autonomy_get's `resolved` field — every dial AUTONOMY_DEFAULTS knows about. */
export type AutonomyResolved = { [K in keyof typeof AUTONOMY_DEFAULTS]: string | boolean };

export function isAutonomyStepSatisfied(resolved: AutonomyResolved): boolean {
  // SAFETY: Object.keys is typed string[] because TS cannot tie it to the object literal's own
  // key set; AUTONOMY_DEFAULTS and AutonomyResolved are defined with the exact same keys above.
  const dials = Object.keys(AUTONOMY_DEFAULTS) as (keyof AutonomyResolved)[];
  return dials.some(key => resolved[key] !== AUTONOMY_DEFAULTS[key]);
}

export function isProjectStepSatisfied(projectCount: number): boolean {
  return projectCount > 0;
}

export type SetupRow = {
  key: "node" | "trantor" | "herdr";
  label: string;
  status: "ok" | "missing" | "outdated";
  detail: string;
  /** What Install runs; null when it cannot be offered (Node missing for the CLI, Node itself). */
  install: "trantor" | "herdr" | null;
  hint: string | null;
};

/** Pure: one status row each for node, the trantor CLI and herdr. */
export function setupRows(r: SetupReport): SetupRow[] {
  const nodeRow: SetupRow = r.node
    ? { key: "node", label: "Node", status: "ok", detail: r.node, install: null, hint: null }
    : { key: "node", label: "Node", status: "missing", detail: "not found", install: null, hint: "Install Node from nodejs.org, then Retry." };
  const canNpm = r.node !== null && r.npm;
  const cli: SetupRow = !r.trantor
    ? { key: "trantor", label: "trantor CLI", status: "missing", detail: "not installed", install: canNpm ? "trantor" : null, hint: canNpm ? null : "Install Node from nodejs.org first." }
    : !r.trantorCompatible
      ? { key: "trantor", label: "trantor CLI", status: "outdated", detail: `${r.trantor}, this app needs ${r.trantorMinimum} or newer`, install: canNpm ? "trantor" : null, hint: canNpm ? null : "Install Node from nodejs.org first." }
      : { key: "trantor", label: "trantor CLI", status: "ok", detail: r.trantor, install: null, hint: null };
  const herdr: SetupRow = r.herdr
    ? { key: "herdr", label: "herdr", status: "ok", detail: r.herdr, install: null, hint: null }
    : { key: "herdr", label: "herdr", status: "missing", detail: "not installed", install: "herdr", hint: null };
  return [nodeRow, cli, herdr];
}

export function isSetupStepSatisfied(r: SetupReport): boolean {
  return setupRows(r).every(row => row.status === "ok");
}
