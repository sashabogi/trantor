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
export type ProviderKind = "windows" | "quota" | "prepaid" | "unknown";
export type ProviderConnect = "cli-login" | "api-key";
export type ProviderAction = "login" | "paste-key" | "recheck" | "remove";

export type ProviderStatus = {
  provider: string;
  label: string;
  kind: ProviderKind;
  connect: ProviderConnect;
  binary: { name: string | null; installed: boolean; path: string | null };
  auth: { artifact: string | null; present: boolean; mode: string | null };
  state: ProviderState;
  reason: string;
  usage: BalanceRow | null;
  actions: ProviderAction[];
};

export type ProviderAccountsApi = {
  status: () => Promise<ProviderStatus[]>;
  login: (provider: string, project: string) => Promise<void>;
  verifyKey: (provider: string, key: string) => Promise<ProviderStatus>;
  saveKey: (provider: string, key: string) => Promise<void>;
  remove: (provider: string) => Promise<void>;
};

async function providerStatus(): Promise<ProviderStatus[]> {
  return JSON.parse(await invoke<string>("provider_status"));
}

type VerifyCommand = (command: "provider_verify", args: { name: string; key: string }) => Promise<string>;
const runVerifyCommand: VerifyCommand = (command, args) => invoke<string>(command, args);

export async function providerVerify(name: string, key: string, run: VerifyCommand = runVerifyCommand): Promise<ProviderStatus> {
  return JSON.parse(await run("provider_verify", { name, key }));
}

export const providerAccountsApi: ProviderAccountsApi = {
  status: providerStatus,
  login: (provider, project) => invoke<void>("provider_login", { provider, project }),
  verifyKey: providerVerify,
  saveKey: (provider, key) => invoke<void>("provider_save_key", { provider, key }),
  remove: provider => invoke<void>("provider_remove", { provider }),
};
