import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type RelayChatApi = {
  get: () => Promise<boolean>;
  set: (on: boolean) => Promise<boolean>;
};
const relayChatApi: RelayChatApi = {
  get: () => invoke<boolean>("relay_chat_get"),
  set: on => invoke<boolean>("relay_chat_set", { on }),
};

export function RelayChat({ api = relayChatApi }: { api?: RelayChatApi }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api.get().then(value => { if (alive) setOn(value); })
      .catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [api]);
  const change = async () => {
    setSaving(true);
    setError("");
    try { setOn(await api.set(!on)); }
    catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };
  return (
    <div className="tr-card mt-3 flex items-center gap-4 p-4">
      <div className="min-w-0 flex-1">
        <div id="relay-chat-label" className="text-[13px] font-medium">Relay chat to my phone</div>
        <p className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">
          Share hosted session chats and accept phone messages while this app is open.
        </p>
        {error && <p role="alert" className="mt-2 text-[12px] text-[var(--color-tr-fail)]">{error}</p>}
      </div>
      <button type="button" role="switch" aria-labelledby="relay-chat-label" aria-checked={on === true}
        disabled={on === null || saving} onClick={() => void change()}
        className="tr-input shrink-0 disabled:opacity-60">
        {saving ? "Saving…" : on === null ? "Loading…" : on ? "On" : "Off"}
      </button>
    </div>
  );
}
