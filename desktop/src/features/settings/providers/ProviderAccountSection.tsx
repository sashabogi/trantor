import { Check, ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { BrandGlyph } from "../../../shared/Avatar";
import { chipFrom } from "../../fleet/balanceChips";
import { stateLabel } from "./ProviderRow";
import { providerPresentation } from "./providerPresentation";
import type { ProviderAccountsApi, ProviderStatus } from "./providerStatus";

type ProviderAccountSectionProps = {
  status: ProviderStatus;
  api: ProviderAccountsApi;
  project: string;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onChanged: () => Promise<void>;
  onRemove: () => void;
};

function StatusLine({ status }: { status: ProviderStatus }) {
  const usage = status.usage ? chipFrom(status.usage) : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-tr-muted)]">
      <span className="tr-chip">{stateLabel(status.state)}</span>
      <span className="min-w-0 flex-1">{status.reason}</span>
      {usage ? <span className="tr-chip tr-mono" title={usage.tooltip}>{usage.value}</span> : null}
    </div>
  );
}

function SectionHeader({ status }: { status: ProviderStatus }) {
  const presentation = providerPresentation(status);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center"><BrandGlyph name={status.provider} size={16} /></span>
        <h3 className="text-[14px] font-semibold">{status.label}</h3>
        {presentation.homepage ? (
          <a href={presentation.homepage} target="_blank" rel="noreferrer" aria-label={`${status.label} documentation`}
             className="text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]"><ExternalLink size={12} /></a>
        ) : null}
      </div>
      <p className="text-[12px] leading-relaxed text-[var(--color-tr-muted)]">{presentation.description}</p>
    </div>
  );
}

function SystemAccountSection(props: ProviderAccountSectionProps) {
  const { status, project, api, busy, onBusy, onChanged, onRemove } = props;
  const login = async () => {
    onBusy(true);
    try {
      await api.login(status.provider, project);
      await onChanged();
    } finally {
      onBusy(false);
    }
  };
  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium">Accounts</div>
          <p className="mt-0.5 text-[11.5px] text-[var(--color-tr-muted)]">Showing the system login on this device.</p>
        </div>
        <button type="button" onClick={() => void login()} disabled={busy}
                className="tr-input flex shrink-0 items-center gap-1.5 disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add Account
        </button>
      </div>
      <div className={`rounded-lg border px-3 py-2.5 ${status.auth.present ? "border-[color-mix(in_srgb,var(--color-tr-ok)_35%,var(--color-tr-edge))]" : "border-[var(--color-tr-edge)]"}`}>
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">System default</span>
          {status.auth.present ? <span className="tr-chip flex items-center gap-1"><Check size={10} /> Active</span> : null}
        </div>
        <p className="mt-1 text-[11.5px] text-[var(--color-tr-muted)]">
          {status.auth.email ?? (status.auth.present ? `Use your current ${status.label} login.` : `No ${status.label} login is saved on this device.`)}
        </p>
      </div>
      <div className="rounded-lg border border-dashed border-[var(--color-tr-edge)] px-3 py-3">
        <StatusLine status={status} />
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={() => void onChanged()} disabled={busy} aria-label={`Re-check ${status.label}`}
                  className="tr-input flex items-center gap-1.5 disabled:opacity-50"><RefreshCw size={12} /> Refresh</button>
          <button type="button" onClick={onRemove} disabled={busy} aria-label={`Remove ${status.label}`}
                  className="tr-input flex items-center gap-1.5 text-[var(--color-tr-fail)] disabled:opacity-50"><Trash2 size={12} /> Remove login</button>
        </div>
      </div>
    </div>
  );
}

function KeyAccountSection(props: ProviderAccountSectionProps) {
  const { status, api, busy, onBusy, onChanged, onRemove } = props;
  const presentation = providerPresentation(status);
  const [key, setKey] = useState("");
  const [phase, setPhase] = useState<"idle" | "verifying" | "saving">("idle");
  const [error, setError] = useState("");
  const submit = async () => {
    const candidate = key.trim();
    if (!candidate) return;
    setError("");
    setPhase("verifying");
    onBusy(true);
    try {
      await api.verifyKey(status.provider, candidate);
      setPhase("saving");
      await api.saveKey(status.provider, candidate);
      setKey("");
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPhase("idle");
      onBusy(false);
    }
  };
  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium">API key</div>
          <p className="mt-0.5 text-[11.5px] text-[var(--color-tr-muted)]">Verified live before Trantor saves it to <code>~/.agent-bus/.env</code>.</p>
        </div>
        <span className="tr-chip shrink-0">{status.auth.present ? "Saved" : "Not saved"}</span>
      </div>
      <div className="flex gap-2">
        <input type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="off" spellCheck={false}
               aria-label={`${status.label} API key`} placeholder={`Paste ${status.label} API key`} className="tr-input min-w-0 flex-1" />
        <button type="button" onClick={() => void submit()} disabled={busy || !key.trim()}
                className="rounded-lg bg-[var(--color-tr-doing)] px-3 text-[12px] font-medium text-white disabled:opacity-50">
          {phase === "verifying" ? "Verifying…" : phase === "saving" ? "Saving…" : "Verify and save"}
        </button>
      </div>
      {error ? <p role="alert" className="text-[12px] text-[var(--color-tr-fail)]">Verification failed — {error}. Nothing was saved.</p> : null}
      <details className="rounded-lg border border-[var(--color-tr-edge)] bg-white/[0.015] px-3 py-2.5">
        <summary className="cursor-pointer text-[12px] font-medium">How to copy</summary>
        <p className="mt-2 text-[11.5px] text-[var(--color-tr-muted)]">Get the key from {presentation.source}.</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11.5px] text-[var(--color-tr-muted)]">
          {presentation.steps?.map(step => <li key={step}>{step}</li>)}
        </ol>
      </details>
      <StatusLine status={status} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => void onChanged()} disabled={busy} aria-label={`Re-check ${status.label}`}
                className="tr-input flex items-center gap-1.5 disabled:opacity-50"><RefreshCw size={12} /> Refresh</button>
        <button type="button" onClick={onRemove} disabled={busy} aria-label={`Remove ${status.label}`}
                className="tr-input flex items-center gap-1.5 text-[var(--color-tr-fail)] disabled:opacity-50"><Trash2 size={12} /> Remove key</button>
      </div>
    </div>
  );
}

function ReadonlyAccountSection(props: ProviderAccountSectionProps) {
  const { status, busy, onChanged } = props;
  return (
    <div className="mt-4 rounded-lg border border-[var(--color-tr-edge)] px-3 py-3">
      <StatusLine status={status} />
      <div className="mt-3 flex justify-end">
        <button type="button" onClick={() => void onChanged()} disabled={busy} aria-label={`Re-check ${status.label}`}
                className="tr-input flex items-center gap-1.5 disabled:opacity-50"><RefreshCw size={12} /> Refresh usage</button>
      </div>
    </div>
  );
}

export function ProviderAccountSection(props: ProviderAccountSectionProps) {
  const presentation = providerPresentation(props.status);
  return (
    <section data-provider={props.status.provider} data-state={props.status.state} className="scroll-mt-6 space-y-1 py-2">
      <SectionHeader status={props.status} />
      <div className="tr-card mt-3 p-4">
        {presentation.mode === "system" ? <SystemAccountSection {...props} />
          : presentation.mode === "key" ? <KeyAccountSection {...props} />
            : <ReadonlyAccountSection {...props} />}
      </div>
    </section>
  );
}
