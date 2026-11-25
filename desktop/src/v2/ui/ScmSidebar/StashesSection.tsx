import { useCallback, useEffect, useState } from "react";
import { Archive, CornerUpLeft, Trash2 } from "lucide-react";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { useEscape } from "../useEscape";
import { scopeStashChange, scopeStashes, scopeStashSave, type GitStash, type GitStashAction } from "../../screens/Code/scopeGitApi";

function StashRow({ stash, busy, onAction }: { stash: GitStash; busy: boolean; onAction: (action: GitStashAction) => void }) {
  const [dropping, setDropping] = useState(false);
  useEscape(() => setDropping(false), dropping);
  return (
    <div data-stash={stash.name} className="flex flex-col">
      <div className="flex items-center gap-1 px-3 py-1.5 text-v2-body">
        <div className="min-w-0 flex-1" title={new Date(stash.created_at * 1000).toLocaleString()}>
          <div className="truncate text-[var(--v2-text)]">{stash.message}</div>
          <div className="v2-mono text-v2-micro text-[var(--v2-muted)]">{stash.name} · {stash.sha.slice(0, 7)}</div>
        </div>
        <IconButton label={`Apply ${stash.name}`} title="Apply this stash and keep it" size={22} disabled={busy} onClick={() => onAction("apply")}><CornerUpLeft size={12} aria-hidden /></IconButton>
        <Button variant="quiet" title="Apply this stash and remove it from the list" disabledReason={busy ? "A stash action is running" : null} onClick={() => onAction("pop")}>Pop</Button>
        <IconButton label={`Drop ${stash.name}`} title="Drop this stash" size={22} disabled={busy} onClick={() => setDropping(true)}><Trash2 size={12} aria-hidden /></IconButton>
      </div>
      {dropping && (
        <div role="alert" data-stash-drop-confirm={stash.name} className="mx-3 mb-1 flex flex-col gap-2 rounded-lg border border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-2.5 py-2 text-v2-body text-[var(--v2-text-2)]">
          <span>Drop {stash.name}? The changes in it are lost.</span>
          <div className="flex gap-2">
            <Button variant="danger" disabledReason={busy ? "A stash action is running" : null} onClick={() => { setDropping(false); onAction("drop"); }}>Drop {stash.name}</Button>
            <Button variant="quiet" onClick={() => setDropping(false)}>Cancel</Button>
          </div>
        </div>
      )}
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
  const saveReason = !message.trim() ? "Write a stash message first" : busy ? "Stashing changes" : null;
  const save = () => run(() => scopeStashSave(project, scope, message));
  return (
    <div className="flex flex-col">
      <div className="flex gap-1.5 px-3 py-2">
        <label htmlFor="v2-stash-message" className="sr-only">Stash message</label>
        <input id="v2-stash-message" value={message} onChange={e => setMessage(e.target.value)} placeholder="Stash message"
          onKeyDown={e => { if (e.key === "Enter" && !saveReason) save(); }}
          className="min-w-0 flex-1 rounded-md border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2 py-1 text-v2-body text-[var(--v2-text)] outline-none focus:border-[var(--v2-accent)]" />
        <Button variant="quiet" icon={<Archive size={12} aria-hidden />} title="Stash the uncommitted changes under this message" disabledReason={saveReason} onClick={save}>Stash</Button>
      </div>
      {error && <div role="alert" className="px-3 py-1.5 text-v2-body text-[var(--v2-bad)]">{error}</div>}
      {!loaded && <div className="px-3 py-1.5 text-v2-body text-[var(--v2-muted)]">Reading stashes</div>}
      {loaded && stashes.length === 0 && <div className="px-3 py-1.5 text-v2-body text-[var(--v2-muted)]">No stashes.</div>}
      {stashes.map(stash => <StashRow key={stash.name} stash={stash} busy={busy}
        onAction={action => run(() => scopeStashChange(project, scope, stash.name, action))} />)}
    </div>
  );
}
