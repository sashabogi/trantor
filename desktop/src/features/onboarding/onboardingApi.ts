import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { OnboardingState } from "./onboardingState";

export type OnboardingApi = {
  get: () => Promise<OnboardingState>;
  hasHubPin: () => Promise<boolean>;
  setStep: (step: string) => Promise<OnboardingState>;
  close: () => Promise<OnboardingState>;
  reopen: () => Promise<OnboardingState>;
};

async function invokeState(cmd: string, args?: InvokeArgs): Promise<OnboardingState> {
  return JSON.parse(await invoke<string>(cmd, args));
}

export const onboardingApi: OnboardingApi = {
  get: () => invokeState("onboarding_get"),
  hasHubPin: () => invoke<boolean>("onboarding_has_hub_pin"),
  setStep: step => invokeState("onboarding_set_step", { step }),
  close: () => invokeState("onboarding_close"),
  reopen: () => invokeState("onboarding_reopen"),
};
