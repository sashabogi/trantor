import { useCallback, useEffect, useState } from "react";
import { ProviderAccountSection } from "./ProviderAccountSection";
import { RemoveProviderSheet } from "./RemoveProviderSheet";
import { providerAccountsApi, type ProviderAccountsApi, type ProviderStatus } from "./providerStatus";
import { SettingsBoundary } from "../SettingsBoundary";

type AccountsPaneProps = {
  project: string;
  api?: ProviderAccountsApi;
};

export function AccountsPane(props: AccountsPaneProps) {
  return (
    <SettingsBoundary area="Provider accounts">
      <AccountsPaneContent {...props} />
    </SettingsBoundary>
  );
}

function AccountsPaneContent({ project, api = providerAccountsApi }: AccountsPaneProps) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [remove, setRemove] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setProviders(null);
    setError("");
    try {
      const result = await api.status();
      if (result.available) {
        setProviders(result.providers);
      } else {
        setError(result.reason);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="relative">
      <div className="mb-7 border-b border-[var(--color-tr-edge)] pb-5">
        <div className="flex items-center gap-2">
          <h2 className="text-[20px] font-semibold">AI Provider Accounts</h2>
          <span className="tr-chip uppercase tracking-wider">Optional</span>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-tr-muted)]">Optional. Trantor works with your existing provider logins; add accounts only if you want Trantor to help connect or switch them.</p>
      </div>
      {error ? (
        <div role="alert" className="tr-card mb-3 border-[color-mix(in_srgb,var(--color-tr-fail)_45%,var(--color-tr-edge))] px-4 py-3 text-[12px] text-[var(--color-tr-fail)]">
          <div>Status unavailable: {error}</div>
          <button type="button" onClick={() => void load()} className="tr-input mt-3">Re-check</button>
        </div>
      ) : null}
      {providers === null && !error ? <div className="tr-card-ghost p-6 text-center text-[13px]">Checking provider accounts…</div> : null}
      {providers?.length === 0 ? <div className="tr-card-ghost p-6 text-center text-[13px]">No providers reported. Re-check after installing a supported CLI.</div> : null}
      <div className="flex flex-col gap-6 divide-y divide-[var(--color-tr-edge)]">
        {providers?.map(provider => (
          <ProviderAccountSection key={provider.provider} status={provider} api={api} project={project}
            busy={busy === provider.provider} onBusy={value => setBusy(value ? provider.provider : null)}
            onChanged={load} onRemove={() => setRemove(provider)} />
        ))}
      </div>
      {remove ? <RemoveProviderSheet provider={remove} api={api} onClose={() => setRemove(null)} onRemoved={() => { setRemove(null); void load(); }} /> : null}
    </div>
  );
}
