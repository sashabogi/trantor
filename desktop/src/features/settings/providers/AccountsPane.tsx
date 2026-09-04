import { useCallback, useEffect, useState } from "react";
import { ProviderRow } from "./ProviderRow";
import { PasteKeySheet } from "./PasteKeySheet";
import { RemoveProviderSheet } from "./RemoveProviderSheet";
import { providerAccountsApi, type ProviderAccountsApi, type ProviderStatus } from "./providerStatus";

export function AccountsPane({ project, api = providerAccountsApi }: { project: string; api?: ProviderAccountsApi }) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [paste, setPaste] = useState<ProviderStatus | null>(null);
  const [remove, setRemove] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setProviders(await api.status());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const login = async (provider: ProviderStatus) => {
    setBusy(provider.provider); setError("");
    try {
      await api.login(provider.provider, project);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const recheck = async (provider: ProviderStatus) => {
    setBusy(provider.provider);
    await load();
    setBusy(null);
  };

  return (
    <div className="relative">
      <div className="mb-5">
        <h2 className="tr-sec-title">Provider accounts</h2>
        <p className="tr-sec-sub">One system login per provider. Live probes decide whether each account is ready.</p>
      </div>
      {error ? <div role="alert" className="tr-card mb-3 border-[color-mix(in_srgb,var(--color-tr-fail)_45%,var(--color-tr-edge))] px-4 py-3 text-[12px] text-[var(--color-tr-fail)]">{error}</div> : null}
      {providers === null ? <div className="tr-card-ghost p-6 text-center text-[13px]">Checking provider accounts…</div> : null}
      {providers?.length === 0 ? <div className="tr-card-ghost p-6 text-center text-[13px]">No providers reported. Re-check after installing a supported CLI.</div> : null}
      <div className="flex flex-col gap-2">
        {providers?.map(provider => (
          <ProviderRow key={provider.provider} status={provider} expanded={expanded === provider.provider}
            busy={busy === provider.provider}
            onExpand={() => setExpanded(cur => cur === provider.provider ? null : provider.provider)}
            onLogin={() => void login(provider)} onPasteKey={() => setPaste(provider)}
            onRecheck={() => void recheck(provider)} onRemove={() => setRemove(provider)} />
        ))}
      </div>
      {paste ? <PasteKeySheet provider={paste} api={api} onClose={() => setPaste(null)} onSaved={() => { setPaste(null); void load(); }} /> : null}
      {remove ? <RemoveProviderSheet provider={remove} api={api} onClose={() => setRemove(null)} onRemoved={() => { setRemove(null); void load(); }} /> : null}
    </div>
  );
}
