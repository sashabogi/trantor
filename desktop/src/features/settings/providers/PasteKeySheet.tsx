import { useState } from "react";
import { ExternalLink, KeyRound, Loader2, X } from "lucide-react";
import { dictGet } from "../../../shared/dict";
import type { ProviderAccountsApi, ProviderStatus } from "./providerStatus";

type KeyGuide = { where: string; url: string; steps: string[] };

const KEY_GUIDES = {
  zai: { where: "Z.ai console", url: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys", steps: ["Open API Keys and sign in.", "Create a key for Trantor.", "Copy the complete key and paste it below."] },
  glm: { where: "Z.ai console", url: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys", steps: ["Open API Keys and sign in.", "Create a key for Trantor.", "Copy the complete key and paste it below."] },
  deepseek: { where: "DeepSeek platform", url: "https://platform.deepseek.com/api_keys", steps: ["Open API keys and sign in.", "Create a new secret key.", "Copy it now and paste it below."] },
  openrouter: { where: "OpenRouter settings", url: "https://openrouter.ai/settings/keys", steps: ["Open Keys and sign in.", "Create a key with the limits you want.", "Copy the key and paste it below."] },
  moonshot: { where: "Moonshot platform", url: "https://platform.moonshot.cn/console/api-keys", steps: ["Open API Keys and sign in.", "Create a key for this machine.", "Copy it and paste it below."] },
  kimi: { where: "Moonshot platform", url: "https://platform.moonshot.cn/console/api-keys", steps: ["Open API Keys and sign in.", "Create a fallback API key.", "Copy it and paste it below."] },
  qwen: { where: "Alibaba Cloud Model Studio", url: "https://bailian.console.aliyun.com/", steps: ["Open API Key management and sign in.", "Create a Model Studio key.", "Copy it and paste it below."] },
} as const satisfies Record<string, KeyGuide>;

const fallbackGuide = (provider: ProviderStatus): KeyGuide => ({
  where: `${provider.label} account console`,
  url: "",
  steps: ["Open the provider's API key page and sign in.", "Create a key for Trantor.", "Copy the complete key and paste it below."],
});

export function PasteKeySheet({ provider, api, onClose, onSaved }: {
  provider: ProviderStatus;
  api: ProviderAccountsApi;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [phase, setPhase] = useState<"idle" | "verifying" | "saving">("idle");
  const [error, setError] = useState("");
  const guide = dictGet(KEY_GUIDES, provider.provider) ?? fallbackGuide(provider);

  const submit = async () => {
    const candidate = key.trim();
    if (!candidate) return;
    setError("");
    setPhase("verifying");
    try {
      await api.verifyKey(provider.provider, candidate);
      setPhase("saving");
      await api.saveKey(provider.provider, candidate);
      setKey("");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  return (
    <div className="tr-backdrop fixed inset-0 z-30 flex items-center justify-center p-6" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="paste-key-title" className="tr-card tr-drawer w-full max-w-lg p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-[var(--color-tr-muted)]"><KeyRound size={16} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="paste-key-title" className="text-[15px] font-semibold">Connect {provider.label} with an API key</h2>
            <p className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">The key is verified live before Trantor saves it to <code>~/.agent-bus/.env</code>.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close paste key sheet" className="p-1.5 text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]"><X size={15} /></button>
        </div>

        <div className="mt-5 rounded-xl border border-[var(--color-tr-edge)] bg-white/[0.02] p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] font-medium">Get the key from {guide.where}</span>
            {guide.url ? <a href={guide.url} target="_blank" rel="noreferrer" className="tr-chip shrink-0 hover:text-[var(--color-tr-text)]">Open <ExternalLink size={10} /></a> : null}
          </div>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[12px] leading-relaxed text-[var(--color-tr-muted)]">
            {guide.steps.map(step => <li key={step}>{step}</li>)}
          </ol>
        </div>

        <label className="mt-4 block text-[12px] text-[var(--color-tr-muted)]">
          API key
          <input type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" spellCheck={false}
                 placeholder={`Paste ${provider.label} key`} className="tr-input mt-1.5 w-full" />
        </label>
        {error ? <p role="alert" className="mt-2 text-[12px] text-[var(--color-tr-fail)]">Verification failed — {error}. Nothing was saved.</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={phase !== "idle"} className="tr-input disabled:opacity-50">Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={!key.trim() || phase !== "idle"}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--color-tr-doing)] px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">
            {phase !== "idle" ? <Loader2 size={12} className="animate-spin" /> : null}
            {phase === "verifying" ? "Verifying…" : phase === "saving" ? "Saving…" : "Verify and save"}
          </button>
        </div>
      </section>
    </div>
  );
}
