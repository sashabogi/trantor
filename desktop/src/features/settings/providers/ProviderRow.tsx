import { ChevronDown, Copy, KeyRound, LogIn, RefreshCw, Trash2 } from "lucide-react";
import { BrandGlyph } from "../../../shared/Avatar";
import { dictGet } from "../../../shared/dict";
import { chipFrom } from "../../fleet/balanceChips";
import type { ProviderStatus, ProviderState } from "./providerStatus";

const STATE_META = {
  connected: { label: "Connected", color: "var(--color-tr-ok)" },
  not_installed: { label: "Not installed", color: "var(--color-tr-muted)" },
  not_logged_in: { label: "Not logged in", color: "var(--color-tr-warn)" },
  expired: { label: "Login expired", color: "var(--color-tr-fail)" },
  over_quota: { label: "Over quota", color: "var(--color-tr-warn)" },
  unknown: { label: "Unknown", color: "var(--color-tr-muted)" },
} as const satisfies Record<ProviderState, { label: string; color: string }>;

const INSTALL_COMMANDS = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  qwen: "npm install -g @qwen-code/qwen-code",
  kimi: "brew install kimi-cli",
  agy: "brew install --cask antigravity",
  dsh: "npm install -g deepseek-cli",
} as const satisfies Record<string, string>;

export function stateLabel(state: ProviderState): string {
  return STATE_META[state].label;
}

function installCommand(status: ProviderStatus): string {
  const known = dictGet(INSTALL_COMMANDS, status.provider);
  if (known) return known;
  return status.binary.name ? `brew install ${status.binary.name}` : `See ${status.label} installation guide`;
}

export function ProviderRow({ status, expanded, busy, onExpand, onLogin, onPasteKey, onRecheck, onRemove }: {
  status: ProviderStatus;
  expanded: boolean;
  busy: boolean;
  onExpand: () => void;
  onLogin: () => void;
  onPasteKey: () => void;
  onRecheck: () => void;
  onRemove: () => void;
}) {
  const meta = STATE_META[status.state];
  const usage = status.usage ? chipFrom(status.usage) : null;
  const install = installCommand(status);
  return (
    <div className="tr-card overflow-hidden" data-provider={status.provider} data-state={status.state}>
      <div className="flex min-w-0 items-center gap-3 px-3.5 py-3">
        <button type="button" onClick={onExpand} aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} ${status.label} account details`}
                className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.035]">
            <BrandGlyph name={status.provider} size={15} />
          </span>
          <span className="min-w-[92px] truncate text-[13px] font-medium">{status.label}</span>
          <span className="flex min-w-[108px] shrink-0 items-center gap-1.5 text-[11.5px] text-[var(--color-tr-muted)]">
            <span className="tr-dot" style={{ background: meta.color }} />
            {meta.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--color-tr-muted)]" title={status.reason}>
            {status.reason}
          </span>
          {usage ? <span className="tr-chip tr-mono shrink-0" title={usage.tooltip}>{usage.value}</span> : null}
          <ChevronDown size={14} className={`shrink-0 text-[var(--color-tr-muted)] transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {status.actions.includes("login") ? (
            <button type="button" onClick={onLogin} disabled={busy} className="tr-input flex items-center gap-1.5 disabled:opacity-50">
              <LogIn size={12} /> Log in
            </button>
          ) : null}
          {status.actions.includes("paste-key") ? (
            <button type="button" onClick={onPasteKey} disabled={busy} className="tr-input flex items-center gap-1.5 disabled:opacity-50">
              <KeyRound size={12} /> Paste key
            </button>
          ) : null}
          <button type="button" onClick={onRecheck} disabled={busy} aria-label={`Re-check ${status.label}`}
                  title="Re-check" className="rounded-lg p-2 text-[var(--color-tr-muted)] hover:bg-white/[0.04] hover:text-[var(--color-tr-text)] disabled:opacity-40">
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
          </button>
          <button type="button" onClick={onRemove} disabled={busy} aria-label={`Remove ${status.label}`}
                  title="Remove" className="rounded-lg p-2 text-[var(--color-tr-muted)] hover:bg-white/[0.04] hover:text-[var(--color-tr-fail)] disabled:opacity-40">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-[var(--color-tr-edge)] px-4 py-3 text-[11.5px] text-[var(--color-tr-muted)]">
          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2">
            <span>System account</span><span>One login on this machine</span>
            <span>Why</span><span className="text-[var(--color-tr-text)]">{status.reason}</span>
            <span>Credential</span><span className="tr-mono truncate">{status.auth.artifact ?? "No credential artifact"}</span>
            <span>Binary</span><span className="tr-mono truncate">{status.binary.path ?? (status.binary.name ? `${status.binary.name} is not on PATH` : "No CLI required")}</span>
            {usage ? <><span>Usage</span><span title={usage.tooltip}>{usage.tooltip}</span></> : null}
          </div>
          {status.state === "not_installed" ? (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-white/[0.025] px-3 py-2">
              <span className="min-w-0 flex-1">Install, then Re-check: <code>{install}</code></span>
              <button type="button" aria-label={`Copy install command for ${status.label}`}
                      onClick={() => void navigator.clipboard?.writeText(install)} className="tr-chip shrink-0 hover:text-[var(--color-tr-text)]">
                <Copy size={11} /> Copy
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
