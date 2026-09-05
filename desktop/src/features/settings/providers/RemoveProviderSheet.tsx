import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import type { ProviderAccountsApi, ProviderStatus } from "./providerStatus";

export function RemoveProviderSheet({ provider, api, onClose, onRemoved }: {
  provider: ProviderStatus;
  api: ProviderAccountsApi;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setRemoving(true); setError("");
    try {
      await api.remove(provider.provider);
      onRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRemoving(false);
    }
  };
  return (
    <div className="tr-backdrop fixed inset-0 z-30 flex items-center justify-center p-6" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="remove-provider-title" className="tr-card tr-drawer w-full max-w-md p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--color-tr-fail)_12%,transparent)] text-[var(--color-tr-fail)]"><Trash2 size={16} /></span>
          <div>
            <h2 id="remove-provider-title" className="text-[15px] font-semibold">Remove {provider.label} login?</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-tr-muted)]">
              Remove clears the saved {provider.label} credential or Trantor provider configuration on this machine. The provider row stays here so you can log in or paste a key again. Existing sessions may need to restart.
            </p>
          </div>
        </div>
        {error ? <p role="alert" className="mt-3 text-[12px] text-[var(--color-tr-fail)]">Remove failed — {error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={removing} className="tr-input disabled:opacity-50">Cancel</button>
          <button type="button" onClick={() => void remove()} disabled={removing}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--color-tr-fail)] px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">
            {removing ? <Loader2 size={12} className="animate-spin" /> : null}
            Remove credential
          </button>
        </div>
      </section>
    </div>
  );
}
