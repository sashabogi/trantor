import { invoke } from "@tauri-apps/api/core";
import type { BalanceRow } from "../../fleet/balanceChips";

export const PROVIDER_STATES = [
  "connected",
  "not_installed",
  "not_logged_in",
  "expired",
  "over_quota",
  "unknown",
] as const;

export type ProviderState = (typeof PROVIDER_STATES)[number];
export type ProviderKind = "windows" | "quota" | "prepaid";
export type ProviderConnect = "cli-login" | "api-key";
export type ProviderAction = "login" | "paste-key" | "recheck" | "remove";

export type ProviderStatus = {
  provider: string;
  label: string;
  kind: ProviderKind;
  connect: ProviderConnect;
  binary: { name: string; installed: boolean; path: string | null };
  auth: { artifact: string | null; present: boolean; mode: string | null };
  state: ProviderState;
  reason: string;
  usage: BalanceRow | null;
  actions: ProviderAction[];
};

export type ProviderAccountsApi = {
  status: () => Promise<ProviderStatus[]>;
  login: (provider: string, project: string) => Promise<void>;
  verifyKey: (provider: string, key: string) => Promise<void>;
  saveKey: (provider: string, key: string) => Promise<void>;
  remove: (provider: string) => Promise<void>;
};

async function providerStatus(): Promise<ProviderStatus[]> {
  return JSON.parse(await invoke<string>("provider_status"));
}

export const providerAccountsApi: ProviderAccountsApi = {
  status: providerStatus,
  login: (provider, project) => invoke<void>("provider_login", { provider, project }),
  verifyKey: (provider, key) => invoke<void>("provider_verify_key", { provider, key }),
  saveKey: (provider, key) => invoke<void>("provider_save_key", { provider, key }),
  remove: provider => invoke<void>("provider_remove", { provider }),
};
