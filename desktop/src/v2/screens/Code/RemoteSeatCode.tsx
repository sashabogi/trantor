// #14493: remote worktrees use only the SSH read commands; local git/editor commands stay unmounted.
import { useEffect, useMemo, useState } from "react";
import {
  errorLine, machineSsh, remoteChangeRows, remoteFileBody, remoteFilePatch, remoteSeatSnapshot,
  type RemoteBody, type RemotePatch, type RemoteSeatSnapshot,
} from "../../../features/code/remoteSeatApi";
import { usePeers } from "../../../shared/presence";
import type { ScreenProps } from "../../routes";
import { Button } from "../../ui/Button";
import { Seg } from "../../ui/Seg";
import { ChatRail } from "./ChatRail";
import { DiffView, type DiffLayout } from "./DiffView";
import { parseUnifiedDiff } from "./diff";
import { Counts } from "./parts";

type Read<T> = { kind: "loading" } | { kind: "ok"; value: T } | { kind: "error"; reason: string };
const reason = (e: Error | string) => errorLine(e instanceof Error ? e.message : String(e));

export function RemoteSeatCode({ client, project, seat, machine, onCheckout }: ScreenProps & {
  seat: string; machine: string; onCheckout: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Read<RemoteSeatSnapshot>>({ kind: "loading" });
  const [picked, setPicked] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const { peers } = usePeers(client);
  const rows = snapshot.kind === "ok" ? remoteChangeRows(snapshot.value) : [];
  const selected = rows.find(row => row.path === picked)?.path ?? rows[0]?.path ?? null;
  useEffect(() => {
    let active = true;
    setSnapshot({ kind: "loading" });
    async function read() {
      const target = await machineSsh(machine);
      if (!target) throw new Error(`No SSH target is configured for ${machine}.`);
      return remoteSeatSnapshot(project, seat, machine);
    }
    read().then(value => { if (active) setSnapshot({ kind: "ok", value }); })
      .catch(e => { if (active) setSnapshot({ kind: "error", reason: reason(e) }); });
    return () => { active = false; };
  }, [project, seat, machine, revision]);
  const refresh = () => { setSnapshot({ kind: "loading" }); setRevision(n => n + 1); };
  const addToChat = (text: string) => { setDraft(d => d.trim() ? `${d}\n${text}` : text); setChatOpen(true); };
  return (
    <div data-testid="remote-code" className="flex min-h-[600px] min-w-0 flex-1 gap-[6px] bg-[var(--v2-chrome)] p-[6px]">
      <section aria-label="Remote worktree" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-bg)]">
        <header className="flex flex-wrap items-center gap-3 border-b border-[var(--v2-edge)] px-3 py-2">
          <span className="min-w-0 flex-1 text-v2-body text-[var(--v2-text)]">{seat}'s worktree on {machine}, read only</span>
          {snapshot.kind === "ok" && <span className="v2-mono text-v2-small text-[var(--v2-muted)]">{snapshot.value.branch}</span>}
          <Button onClick={refresh}>Refresh</Button>
          <Button onClick={onCheckout}>Open project checkout</Button>
        </header>
        {snapshot.kind === "loading" && <p role="status" className="p-4 text-v2-body text-[var(--v2-muted)]">Reading {seat}'s worktree on {machine}…</p>}
        {snapshot.kind === "error" && <div role="alert" className="p-4 text-v2-body text-[var(--v2-muted)]">Could not read {seat}'s worktree on {machine}. {snapshot.reason}</div>}
        {snapshot.kind === "ok" && (rows.length === 0
          ? <p className="p-4 text-v2-body text-[var(--v2-muted)]">No changed files in this remote worktree.</p>
          : <div className="flex min-h-0 min-w-0 flex-1">
            <nav aria-label="Remote changed files" className="w-[260px] shrink-0 overflow-auto border-r border-[var(--v2-edge)] p-2">
              {rows.map(row => <button key={row.path} type="button" title={row.path} aria-pressed={row.path === selected} onClick={() => setPicked(row.path)}
                className="v2-hover flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-v2-body text-[var(--v2-text-2)] aria-pressed:bg-[var(--v2-accent-soft)]">
                <span className="v2-mono text-v2-small text-[var(--v2-muted)]">{row.status}</span>
                <span className="min-w-0 flex-1 truncate">{row.path}</span><Counts plus={row.plus} minus={row.minus} />
              </button>)}
            </nav>
            {selected && <RemoteFile key={`${selected}:${revision}`} project={project} seat={seat} machine={machine} path={selected} onAddToChat={addToChat} />}
          </div>)}
      </section>
      <ChatRail client={client} project={project} peers={peers} open={chatOpen} onToggle={() => setChatOpen(o => !o)} draft={draft} onDraft={setDraft} want={null} />
    </div>
  );
}

function RemoteFile({ project, seat, machine, path, onAddToChat }: {
  project: string; seat: string; machine: string; path: string; onAddToChat: (text: string) => void;
}) {
  const [view, setView] = useState<"diff" | "file">("diff");
  const [layout, setLayout] = useState<DiffLayout>("combined");
  const [body, setBody] = useState<Read<RemoteBody>>({ kind: "loading" });
  const [patch, setPatch] = useState<Read<RemotePatch>>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    remoteFileBody(project, seat, machine, path).then(value => { if (active) setBody({ kind: "ok", value }); })
      .catch(e => { if (active) setBody({ kind: "error", reason: reason(e) }); });
    remoteFilePatch(project, seat, machine, path).then(value => { if (active) setPatch({ kind: "ok", value }); })
      .catch(e => { if (active) setPatch({ kind: "error", reason: reason(e) }); });
    return () => { active = false; };
  }, [project, seat, machine, path]);
  const files = useMemo(() => patch.kind === "ok" ? parseUnifiedDiff(patch.value.patch) : [], [patch]);
  const read = view === "file" ? body : patch;
  return (
    <section aria-label="Remote file viewer" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-3 py-2">
        <span className="v2-mono min-w-0 flex-1 truncate text-v2-body text-[var(--v2-text)]">{path}</span>
        <Seg label="Remote file view" value={view} onChange={setView} options={[{ value: "diff", label: "Diff vs base" }, { value: "file", label: "File" }]} />
      </header>
      {read.kind === "loading" && <p role="status" className="p-4 text-v2-body text-[var(--v2-muted)]">Reading over SSH…</p>}
      {read.kind === "error" && <div role="alert" className="p-4 text-v2-body text-[var(--v2-muted)]">{read.reason}</div>}
      {read.kind === "ok" && read.value.truncated && <p role="status" className="px-3 py-2 text-v2-body text-[var(--v2-warn)]">This {view === "file" ? "file" : "diff"} is too large to show in full. Only the beginning is shown.</p>}
      {view === "file" && body.kind === "ok" && <pre tabIndex={0} aria-label="Remote file contents" className="v2-mono m-0 min-h-0 flex-1 overflow-auto whitespace-pre p-3 text-v2-body text-[var(--v2-text)]">{body.value.text}</pre>}
      {view === "diff" && patch.kind === "ok" && (files.length
        ? <DiffView files={files} layout={layout} onLayout={setLayout} onAddToChat={onAddToChat} onOpenFile={() => setView("file")} />
        : <p className="p-4 text-v2-body text-[var(--v2-muted)]">No diff against the base for this file.</p>)}
    </section>
  );
}
