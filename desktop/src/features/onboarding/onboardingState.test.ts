import { describe, expect, it } from "vitest";
import {
  AUTONOMY_DEFAULTS,
  isAutonomyStepSatisfied,
  isIdentityStepSatisfied,
  isProjectStepSatisfied,
  isProvidersStepSatisfied,
  shouldShowOnboarding,
} from "./onboardingState";
import type { ProviderStatus } from "../settings/providers/providerStatus";

const provider = (state: ProviderStatus["state"]): ProviderStatus => ({
  provider: "codex", label: "Codex", kind: "windows", connect: "cli-login",
  binary: { name: "codex", installed: true, path: "/usr/bin/codex" },
  auth: { artifact: null, present: state === "connected", mode: null },
  state, reason: "", usage: null, actions: [],
});

describe("shouldShowOnboarding", () => {
  it("is false while the state has not loaded yet", () => {
    expect(shouldShowOnboarding(null)).toBe(false);
  });
  it("is true only when closedAt is null", () => {
    expect(shouldShowOnboarding({ flowVersion: 1, closedAt: null, lastCompletedStep: null })).toBe(true);
    expect(shouldShowOnboarding({ flowVersion: 1, closedAt: 123, lastCompletedStep: null })).toBe(false);
  });
});

describe("isProvidersStepSatisfied", () => {
  it("needs at least one connected provider", () => {
    expect(isProvidersStepSatisfied([])).toBe(false);
    expect(isProvidersStepSatisfied([provider("not_logged_in")])).toBe(false);
    expect(isProvidersStepSatisfied([provider("not_logged_in"), provider("connected")])).toBe(true);
  });
});

describe("isIdentityStepSatisfied", () => {
  it("mirrors the hub-pin signal directly", () => {
    expect(isIdentityStepSatisfied(false)).toBe(false);
    expect(isIdentityStepSatisfied(true)).toBe(true);
  });
});

describe("isAutonomyStepSatisfied", () => {
  it("is false when every dial still reads the shipped default", () => {
    expect(isAutonomyStepSatisfied({ ...AUTONOMY_DEFAULTS })).toBe(false);
  });
  it("is true the moment any one dial has moved off default", () => {
    expect(isAutonomyStepSatisfied({ ...AUTONOMY_DEFAULTS, commit: true })).toBe(true);
    expect(isAutonomyStepSatisfied({ ...AUTONOMY_DEFAULTS, harness: "bypass" })).toBe(true);
  });
  it("ignores fields it does not know about", () => {
    expect(isAutonomyStepSatisfied({ ...AUTONOMY_DEFAULTS, someFutureDial: true })).toBe(false);
  });
});

describe("reset (\"Show onboarding again\")", () => {
  it("reopening clears closedAt and lastCompletedStep but keeps flowVersion, so the wizard shows again", () => {
    const closed = { flowVersion: 1, closedAt: 1_700_000_000_000, lastCompletedStep: "project" };
    expect(shouldShowOnboarding(closed)).toBe(false);
    const reopened = { ...closed, closedAt: null, lastCompletedStep: null };
    expect(reopened.flowVersion).toBe(closed.flowVersion);
    expect(shouldShowOnboarding(reopened)).toBe(true);
  });
});

describe("isProjectStepSatisfied", () => {
  it("needs at least one known project", () => {
    expect(isProjectStepSatisfied(0)).toBe(false);
    expect(isProjectStepSatisfied(1)).toBe(true);
  });
});
