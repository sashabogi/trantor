// The REVIEW lens (mockup: artifact 3d6dbb67, artboard 2) — what is this seat actually CHANGING?
// Seat picker up top, the seat's files on the left, the unified diff in the center, and a real
// composer underneath: "send a note to this seat about what you see" rides the bus TODAY; the
// inline-anchored-to-a-line comment is Phase 2.5 and is deliberately NOT faked here.
//
// HONESTY RULE (same as Workspace): every byte rendered is real — the diff comes from codex's
// seat_diff against the seat's own worktree, and a seat with no worktree gets a stated ghost
// card naming worktree-per-seat as the source, never an empty diff pretending to be one.
import { useEffect, useMemo, useState } from "react";
import type { Card, HubClient, Peer } from "../../shared/api/client";
import { ProjectHeader, type Lens } from "../project/ProjectHeader";
import { parsePatch, type DiffFile } from "./diff";
import { seatDiff, type SeatDiff } from "./seatDiff";
import { GitPanel } from "./GitPanel";

// A seat = a crew peer of this project. The operator's own sessions are excluded outright: review
// compares a seat's WORKTREE against its base, and the operator has no worktree, so listing them
// only ever offered a tab that could never hold a diff — under a raw bus id, next to real seats.
function seatsOf(peers: Peer[], project: string): Peer[] {
  return peers
    .filter(p => p.session.endsWith(`:${project}`))
    .filter(p => !p.session.toLowerCase().startsWith("macbook"));
}

const seatName = (session: string) => session.split(":")[0];

// seat_diff's Err strings are plain sentences (#5366); "worktree" is the one that means "nothing
// to review yet", which is a ghost card, not an error banner.
const isNoWorktree = (reason: string) => /worktree/i.test(reason);

type Load =
  | { kind: "loading" }
  | { kind: "empty"; reason: string }
  | { kind: "error"; reason: string }
  | { kind: "ok"; diff: SeatDiff; files: DiffFile[]; truncated: boolean };

function DiffBody({ file }: { file: DiffFile }) {
  return (
    <div className="tr-mono text-[12px] leading-[1.7]">
      {file.hunks.map((h, hi) => (
        <div key={hi}>
          <div className="px-3 py-1 text-[11px] text-tr-muted/70">{h.header}</div>
          {h.lines.map((l, li) => (
            <div key={li}
              className="flex"
              style={l.kind === "add" ? { background: "rgba(20,184,166,0.08)" }
                   : l.kind === "del" ? { background: "rgba(239,106,106,0.09)" }
                   : undefined}>
              <span className="w-10 shrink-0 select-none pr-2 text-right text-tr-muted/50">{l.oldNo ?? ""}</span>
              <span className="w-10 shrink-0 select-none pr-2 text-right text-tr-muted/50">{l.newNo ?? ""}</span>
              <span className={`shrink-0 select-none px-1 ${l.kind === "add" ? "text-tr-ok" : l.kind === "del" ? "text-tr-fail" : "text-tr-muted/50"}`}>
                {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Review({ client, project, lens, onLens }: {
  client: HubClient; project: string; lens: Lens; onLens: (l: Lens) => void;
}) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [tasks, setTasks] = useState<Card[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [selFile, setSelFile] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<"ok" | "fail" | null>(null);
  // the git rail (#5775): hidden by default — the diff is the lens's reason to exist — and a
  // nonce the rail bumps after commit/push so the diff re-pulls instead of lying about landed work
  const [gitOpen, setGitOpen] = useState(false);
  const [diffNonce, setDiffNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const pull = () => {
      client.peers().then(p => { if (alive) setPeers(p); }).catch(() => {});
      client.tasks(project).then(t => { if (alive) setTasks(t); }).catch(() => {});
    };
    pull();
    const iv = setInterval(pull, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [client, project]);

  const seats = useMemo(() => seatsOf(peers, project), [peers, project]);
  const selected = seats.find(s => s.session === sel) ?? seats[0];

  // The seat's diff — re-pulled on a slow cadence (a diff is a snapshot, not a stream) and
  // whenever the picker moves. setSelFile resets per seat: file paths are seat-local.
  useEffect(() => {
    if (!selected) { setLoad({ kind: "loading" }); return; }
    let alive = true;
    const pull = () => seatDiff(project, seatName(selected.session))
      .then(diff => {
        if (!alive) return;
        const parsed = parsePatch(diff.patch, diff.truncated ?? false);
        setLoad({ kind: "ok", diff, files: parsed.files, truncated: parsed.truncated });
      })
      .catch(e => {
        if (!alive) return;
        const reason = String(e);
        setLoad(isNoWorktree(reason) ? { kind: "empty", reason } : { kind: "error", reason });
      });
    pull();
    const iv = setInterval(pull, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [project, selected, diffNonce]);

  // The seat's in-flight card, if it owns one — the composer refs it so the seat knows which
  // card the note is about. Same lookup the Workspace record rail does.
  const seatCard = useMemo(() => {
    if (!selected) return undefined;
    return tasks.find(t => (t.status === "doing" || t.status === "testing") && t.assignee === selected.session);
  }, [tasks, selected]);

  const ok = load.kind === "ok" ? load : null;
  const openFile = ok?.files.find(f => f.path === selFile) ?? ok?.files[0];

  const send = async () => {
    const text = note.trim();
    if (!selected || !text || sending) return;
    setSending(true);
    try {
      // The card ref rides in the TEXT — the bus has no side-channel for it, and a seat reading
      // its inbox sees "#5368 <note>" exactly like every other card reference it already gets.
      await client.send(selected.session, (seatCard ? `#${seatCard.id} ` : "") + text, project);
      setNote("");
      setSent("ok");
    } catch {
      setSent("fail");
    } finally {
      setSending(false);
    }
  };

  const sub = ok
    ? `${ok.diff.branch || "detached"} · base ${ok.diff.base.slice(0, 8)} · +${ok.files.reduce((n, f) => n + f.adds, 0)} −${ok.files.reduce((n, f) => n + f.dels, 0)}`
    : `${seats.length} seat${seats.length === 1 ? "" : "s"} · pick one to see its diff`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeader project={project} sub={sub} lens={lens} onLens={onLens} />
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-6">

        {/* seat picker — the same tabs the Workspace lens opens with */}
        <div className="flex items-center gap-1">
          {seats.length === 0 && (
            <div className="tr-card-ghost px-4 py-2 text-[12.5px]">
              No seats on this project — fire some up with <span className="tr-mono">trantor up</span>
            </div>
          )}
          {seats.map(s => (
            <button
              key={s.session}
              onClick={() => { setSel(s.session); setSelFile(null); }}
              data-on={selected?.session === s.session}
              className="flex items-center gap-2 rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
            >
              <span className={`tr-dot ${s.online ? "bg-tr-doing" : "bg-tr-muted/50"}`} />
              {seatName(s.session)}
            </button>
          ))}
          {seats.length > 0 && (
            <button
              onClick={() => setGitOpen(o => !o)}
              data-on={gitOpen}
              title="git: stage, commit, push this seat's worktree"
              className="ml-auto rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
            >
              git
            </button>
          )}
        </div>

        {load.kind === "empty" && (
          <div className="mt-2.5 flex flex-1 items-center justify-center">
            <div className="tr-card-ghost max-w-[460px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
              Nothing to review — <span className="tr-mono">{selected?.session}</span> has no
              worktree yet. Diffs appear here once the seat works worktree-per-seat
              (<span className="tr-mono">~/.agent-bus/worktrees/{project}/&lt;agent&gt;</span>).
            </div>
          </div>
        )}
        {load.kind === "error" && (
          <div className="mt-2.5 flex flex-1 items-center justify-center">
            <div className="tr-card-ghost max-w-[460px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
              The seat's diff could not be read: <span className="tr-mono">{load.reason}</span>
            </div>
          </div>
        )}

        {ok && (
          <div className="mt-2.5 flex min-h-0 flex-1 gap-4">
            {/* files list */}
            <div className="tr-card flex w-[264px] shrink-0 flex-col px-2 py-2">
              <div className="flex items-center justify-between px-2 pt-1 pb-2">
                <span className="text-[13px] font-semibold">Files</span>
                {ok.truncated && <span className="tr-chip" title="patch capped at 400KB seat-side">truncated</span>}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {ok.diff.files.length === 0 && (
                  <div className="px-2 py-2 text-[12px] text-tr-muted">Clean — no changes against base.</div>
                )}
                {ok.diff.files.map(f => (
                  <button
                    key={f.path}
                    onClick={() => setSelFile(f.path)}
                    data-on={(openFile?.path ?? "") === f.path}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-tr-muted data-[on=true]:bg-white/[0.06] data-[on=true]:text-tr-text"
                  >
                    <span className="tr-mono min-w-0 flex-1 truncate">{f.path}</span>
                    {f.untracked
                      ? <span className="tr-chip shrink-0">untracked</span>
                      : <span className="tr-mono shrink-0 text-[11px]">
                          <span className="text-tr-ok">+{f.plus ?? 0}</span>{" "}
                          <span className="text-tr-fail">−{f.minus ?? 0}</span>
                        </span>}
                  </button>
                ))}
              </div>
            </div>

            {/* unified diff + composer */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="tr-card min-h-0 flex-1 overflow-y-auto">
                {openFile ? (
                  <>
                    <div className="sticky top-0 flex items-center gap-2 border-b border-tr-edge bg-tr-panel px-3 py-2">
                      <span className="tr-mono min-w-0 flex-1 truncate text-[12px]">{openFile.path}</span>
                      {openFile.isNew && <span className="tr-chip">new</span>}
                      {openFile.isDeleted && <span className="tr-chip">deleted</span>}
                      <span className="tr-mono shrink-0 text-[11px]">
                        <span className="text-tr-ok">+{openFile.adds}</span>{" "}
                        <span className="text-tr-fail">−{openFile.dels}</span>
                      </span>
                    </div>
                    <DiffBody file={openFile} />
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="tr-card-ghost max-w-[380px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
                      {ok.diff.files.length === 0
                        ? "The worktree is clean against its base — nothing to review yet."
                        : "This file has no textual diff (untracked or binary) — open another file."}
                    </div>
                  </div>
                )}
              </div>

              {/* composer — REAL send over the bus; line-anchored comments are Phase 2.5 */}
              <div className="tr-card mt-2.5 flex items-end gap-2.5 px-3.5 py-2.5">
                <textarea
                  value={note}
                  onChange={e => { setNote(e.target.value); setSent(null); }}
                  rows={2}
                  placeholder={selected ? `Note for ${seatName(selected.session)} about this diff…` : "Pick a seat first"}
                  className="min-w-0 flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-tr-muted/60"
                />
                {sent === "ok" && <span className="tr-chip shrink-0">sent</span>}
                {sent === "fail" && <span className="tr-chip shrink-0" style={{ color: "var(--color-tr-fail)" }}>send failed</span>}
                <button
                  onClick={() => { void send(); }}
                  disabled={!selected || !note.trim() || sending}
                  className="shrink-0 rounded-lg bg-tr-doing/20 px-3 py-1.5 text-[12.5px] font-medium text-tr-doing disabled:opacity-40"
                >
                  Send to {selected ? seatName(selected.session) : "…"}
                </button>
              </div>
            </div>

            {/* git rail (#5775) — stage/unstage, commit, push, log for the selected seat */}
            {gitOpen && selected && (
              <div className="w-[300px] shrink-0">
                <GitPanel
                  project={project}
                  seat={seatName(selected.session)}
                  onChanged={() => setDiffNonce(n => n + 1)}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
