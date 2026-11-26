import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { OnboardingState } from "./onboardingState";

export const ONBOARDING_REOPENED = "trantor:onboarding-reopened";

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
  reopen: async () => {
    const state = await invokeState("onboarding_reopen");
    // The 2.0 shell mounts the wizard and has no other way to learn the disk state changed.
    window.dispatchEvent(new Event(ONBOARDING_REOPENED));
    return state;
  },
};
