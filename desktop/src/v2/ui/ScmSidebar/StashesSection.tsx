import { useCallback, useEffect, useState } from "react";
import { Archive, CornerUpLeft, Trash2 } from "lucide-react";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { scopeStashChange, scopeStashes, scopeStashSave, type GitStash, type GitStashAction } from "../../screens/Code/scopeGitApi";

function StashRow({ stash, busy, onAction }: { stash: GitStash; busy: boolean; onAction: (action: GitStashAction) => void }) {
  return (
    <div data-stash={stash.name} className="flex items-center gap-1 px-3 py-1.5 text-[11.5px]">
      <div className="min-w-0 flex-1" title={new Date(stash.created_at * 1000).toLocaleString()}>
        <div className="truncate text-[var(--v2-text)]">{stash.message}</div>
        <div className="v2-mono text-[10px] text-[var(--v2-muted)]">{stash.name} · {stash.sha.slice(0, 7)}</div>
      </div>
      <IconButton label={`Apply ${stash.name}`} title="Apply this stash and keep it" size={22} disabled={busy} onClick={() => onAction("apply")}><CornerUpLeft size={12} aria-hidden /></IconButton>
      <Button variant="quiet" disabledReason={busy ? "A stash action is running" : null} onClick={() => onAction("pop")}>Pop</Button>
      <IconButton label={`Drop ${stash.name}`} title="Drop this stash" size={22} disabled={busy} onClick={() => onAction("drop")}><Trash2 size={12} aria-hidden /></IconButton>
    </div>
  );
}

export function StashesSection({ project, scope, onMutated }: { project: string; scope: string | null; onMutated: () => void }) {
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    try {
      setStashes(await scopeStashes(project, scope));
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoaded(true); }
  }, [project, scope]);
  useEffect(() => { setLoaded(false); void reload(); }, [reload]);
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    work().then(async () => { setMessage(""); await reload(); onMutated(); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col">
      <div className="flex gap-1.5 px-3 py-2">
        <label htmlFor="v2-stash-message" className="sr-only">Stash message</label>
        <input id="v2-stash-message" value={message} onChange={e => setMessage(e.target.value)} placeholder="Stash message"
          className="min-w-0 flex-1 rounded-md border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2 py-1 text-[11.5px] text-[var(--v2-text)] outline-none focus:border-[var(--v2-accent)]" />
        <Button variant="quiet" icon={<Archive size={12} aria-hidden />} disabledReason={!message.trim() ? "Write a stash message first" : busy ? "Stashing changes" : null}
          onClick={() => run(() => scopeStashSave(project, scope, message))}>Stash</Button>
      </div>
      {error && <div role="alert" className="px-3 py-1.5 text-[11.5px] text-[var(--v2-bad)]">{error}</div>}
      {!loaded && <div className="px-3 py-1.5 text-[11.5px] text-[var(--v2-muted)]">Reading stashes</div>}
      {loaded && stashes.length === 0 && <div className="px-3 py-1.5 text-[11.5px] text-[var(--v2-muted)]">No stashes.</div>}
      {stashes.map(stash => <StashRow key={stash.name} stash={stash} busy={busy}
        onAction={action => run(() => scopeStashChange(project, scope, stash.name, action))} />)}
    </div>
  );
}
