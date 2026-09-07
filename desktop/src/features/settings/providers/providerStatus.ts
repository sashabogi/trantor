import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { BalanceRow } from "../../fleet/balanceChips";
import { trantorCliCompatibility, type TrantorCliCompatibility } from "../../../shared/api/client";

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
  auth: { artifact: string | null; present: boolean; mode: string | null; email?: string | null };
  state: ProviderState;
  reason: string;
  usage: BalanceRow | null;
  actions: ProviderAction[];
};

export type ProviderStatusResult =
  | { available: true; providers: ProviderStatus[] }
  | { available: false; reason: string };

export type ProviderAccountsApi = {
  status: () => Promise<ProviderStatusResult>;
  login: (provider: string, project: string) => Promise<void>;
  verifyKey: (provider: string, key: string) => Promise<ProviderStatus>;
  saveKey: (provider: string, key: string) => Promise<void>;
  remove: (provider: string) => Promise<void>;
};

type StatusCommand = (command: "provider_status") => Promise<string>;
const runStatusCommand: StatusCommand = command => invoke<string>(command);
type StatusCommands = {
  compatibility: () => Promise<TrantorCliCompatibility>;
  status: StatusCommand;
};
const statusCommands: StatusCommands = {
  compatibility: trantorCliCompatibility,
  status: runStatusCommand,
};

export async function providerStatus(commands: StatusCommands = statusCommands): Promise<ProviderStatusResult> {
  let compatibility: TrantorCliCompatibility;
  try {
    compatibility = await commands.compatibility();
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error && error.message ? error.message : String(error),
    };
  }
  if (!compatibility.compatible) {
    return { available: false, reason: compatibility.reason ?? `trantor CLI ${compatibility.installed ?? "unknown"} is incompatible` };
  }
  let raw: string;
  try {
    raw = await commands.status("provider_status");
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error && error.message ? error.message : String(error),
    };
  }
  try {
    const decoded = JSON.parse(raw);
    if (!Array.isArray(decoded)) {
      return { available: false, reason: "provider status returned a non-list response" };
    }
    return { available: true, providers: decoded };
  } catch {
    const detail = raw.trim().slice(0, 160) || "empty response";
    return { available: false, reason: `provider status returned invalid JSON: ${detail}` };
  }
}

type VerifyCommand = (command: "provider_verify", args: { name: string; key: string }) => Promise<string>;
const runVerifyCommand: VerifyCommand = (command, args) => invoke<string>(command, args);

export async function providerVerify(name: string, key: string, run: VerifyCommand = runVerifyCommand): Promise<ProviderStatus> {
  return JSON.parse(await run("provider_verify", { name, key }));
}

type CompatibilityCommand = () => Promise<TrantorCliCompatibility>;
type AccountInvoke = <T>(command: string, args?: InvokeArgs) => Promise<T>;

async function requireCompatibleCli(compatibility: CompatibilityCommand): Promise<void> {
  const result = await compatibility();
  if (!result.compatible) {
    throw new Error(result.reason ?? `trantor CLI ${result.installed ?? "unknown"} is incompatible`);
  }
}

export function createProviderAccountsApi(
  compatibility: CompatibilityCommand = trantorCliCompatibility,
  run: AccountInvoke = <T,>(command: string, args?: InvokeArgs) => invoke<T>(command, args),
): ProviderAccountsApi {
  const action = async <T,>(command: string, args?: InvokeArgs): Promise<T> => {
    await requireCompatibleCli(compatibility);
    return run<T>(command, args);
  };
  return {
    status: () => providerStatus({
      compatibility,
      status: command => run<string>(command),
    }),
    login: (provider, project) => action<void>("provider_login", { provider, project }),
    verifyKey: async (provider, key) => JSON.parse(await action<string>("provider_verify", { name: provider, key })),
    saveKey: (provider, key) => action<void>("provider_save_key", { provider, key }),
    remove: provider => action<void>("provider_remove", { provider }),
  };
}

export const providerAccountsApi = createProviderAccountsApi();
