// Reading and changing the code, in the app.
//
// The v3 editor core (#5809), shaped by Orca's renderer (RESEARCH-orca-renderer.md):
//
// 1. A file opens EDITABLE, always. There is no edit button and no read/edit switch — an editor
//    that needs a mode change before it accepts a keystroke is the invention the deletion map
//    retired. The seat-working guard still holds server-side; herdr owns that signal, asked
//    through Rust, because the runner reports it there at every turn boundary.
//
// 2. "Changes" is the open file wearing a diff: HEAD on the left, the LIVE editor on the right
//    (Orca's ChangesModeView anatomy — ChangesModeView.tsx:12-16, 99). The same draft both views
//    edit, so dirty tracking, save, and the conflict bar are one truth.
//
// 3. Saving is a PLAIN file write — no staging, no commit (file_write_plain). Dirty work stays
//    visible in the Changes view until an explicit stage/commit; the authorship record is an
//    honest act, not a keystroke's side effect.
import { useEffect, useMemo, useRef, useState } from "react";
import type { HubClient, Peer } from "../../shared/api/client";
import { ProjectHeader, type Lens } from "../project/ProjectHeader";
import { fileStat, readFile, readFileAtHead, seatState, writePlain, type FileBody } from "./fileApi";
import { CodeView } from "./CodeView";
import { ChangesView } from "./ChangesView";
import { decideReload, type FileStat } from "./liveReload";
import { seatDiff } from "../review/seatDiff";
import { listen } from "@tauri-apps/api/event";

type ViewMode = "code" | "changes";

const seatName = (session: string) => session.split(":")[0];

export function Files({ client, project, lens, onLens, path, seat, onSeat }: {
  client: HubClient;
  project: string;
  lens: Lens;
  onLens: (l: Lens) => void;
  path: string | null;
  seat: string | null;
  onSeat: (s: string | null) => void;
}) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [view, setView] = useState<ViewMode>("code");
  const [body, setBody] = useState<FileBody | null>(null);
  const [head, setHead] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  // The disk stat we last acted on, and whether the editor holds unsaved work. Both live in refs
  // so the poll reads the CURRENT values without tearing the interval down every render.
  const statRef = useRef<FileStat | null>(null);
  const dirtyRef = useRef(false);
  // The editor is always live: unsaved work is simply "the draft differs from the disk".
  dirtyRef.current = body !== null && draft !== body.text;

  useEffect(() => {
    let alive = true;
    const load = () => { client.peers().then(p => { if (alive) setPeers(p); }).catch(() => {}); };
    load();
    const iv = setInterval(load, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [client]);

  const seats = useMemo(
    () => peers.filter(p => p.session.endsWith(`:${project}`) && !p.session.toLowerCase().startsWith("macbook")),
    [peers, project],
  );

  // Changed-file count per seat worktree, for the source-tab badges. Same seatDiff the Review
  // lens reads — one truth about "what did this seat touch". Polled at the peers cadence; a
  // failed read stays absent (clean and unknown must not look different in a scary way).
  const [seatChanges, setSeatChanges] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    const pull = () => {
      for (const s of seats) {
        const name = seatName(s.session);
        seatDiff(project, name)
          .then(d => { if (alive) setSeatChanges(prev => ({ ...prev, [name]: d.files.length })); })
          .catch(() => {});
      }
    };
    pull();
    const iv = setInterval(pull, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [seats, project]);

  // ONE owner for "is this seat writing right now". Deriving it a second way from bus status is how
  // the view and the writer end up disagreeing about whether an edit is safe.
  useEffect(() => {
    if (!seat) { setBusy(false); return; }
    let alive = true;
    const look = () => { seatState(seat).then(st => { if (alive) setBusy(st === "working"); }).catch(() => {}); };
    look();
    const iv = setInterval(look, 5_000);
    return () => { alive = false; clearInterval(iv); };
  }, [seat]);

  const reload = () => {
    if (!path) return;
    readFile(project, path, seat ?? undefined)
      .then(b => { setBody(b); setDraft(b.text); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
    readFileAtHead(project, path, seat ?? undefined).then(setHead).catch(() => setHead(""));
  };

  useEffect(() => {
    if (!path) { setBody(null); setHead(null); setError(null); setDraft(""); setSaved(false); return; }
    setBody(null); setHead(null); setError(null); setDraft(""); setSaved(false);
    setConflict(false);
    setView("code");
    statRef.current = null;
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, path, seat]);

  // The open file follows the disk via fs watch events instead of polling.
  // decideReload (7 legs, UNTOUCHED) decides reload vs conflict vs none.
  useEffect(() => {
    if (!path) return;
    let alive = true;

    const unlisten = listen<{ project: string; paths: string[] }>("file-changed", ev => {
      if (!alive || ev.payload.project !== project) return;
      const changed = ev.payload.paths;
      if (!changed.includes(path)) return;
      fileStat(project, path, seat ?? undefined)
        .then(st => {
          if (!alive) return;
          const decision = decideReload({ dirty: dirtyRef.current, lastStat: statRef.current, newStat: st });
          if (decision === "reload") {
            statRef.current = st;
            setConflict(false);
            reload();
          } else if (decision === "conflict") {
            setConflict(true);
          } else if (statRef.current === null) {
            statRef.current = st;
          }
        })
        .catch(() => {});
    });

    return () => { alive = false; unlisten.then(u => u()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, path, seat]);

  // The Changes view compares HEAD against the LIVE draft — the same document the code view
  // edits — so it stays truthful through every keystroke, not just at save time.
  const changedFromHead = head !== null && head !== draft;

  const save = () => {
    if (!path || busy) return;
    setSaving(true); setError(null);
    writePlain(project, path, seat ?? undefined, draft)
      .then(() => {
        setSaved(true);
        setConflict(false);
        // Our own save moved the disk; drop the baseline so the next poll re-baselines instead of
        // reading our own write as an external change.
        statRef.current = null;
        reload();
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  const dirty = body !== null && draft !== body.text;
  const sub = path
    ? `${seat ? `seat/${seat}` : "project"} · ${path}${body ? ` · ${body.bytes.toLocaleString()} bytes` : ""}`
    : "pick a file in the sidebar";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeader project={project} sub={sub} lens={lens} onLens={onLens} />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-8 pb-6">
        <div className="flex items-center gap-1">
          {/* WHICH COPY. The checkout and a seat's worktree are different files at one path. */}
          <button
            type="button"
            onClick={() => onSeat(null)}
            data-on={seat === null}
            className="rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
          >
            project
          </button>
          {seats.map(s => (
            <button
              key={s.session}
              type="button"
              onClick={() => onSeat(seatName(s.session))}
              data-on={seat === seatName(s.session)}
              className="flex items-center gap-1.5 rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
            >
              {seatName(s.session)}
              {/* the answer to "which files have been edited, and WHERE" (2026-09-01): each
                  source tab carries its changed-file count, so an edited worktree announces
                  itself before you click into it. Absent = clean, never a zero. */}
              {(seatChanges[seatName(s.session)] ?? 0) > 0 && (
                <span className="tr-mono rounded-full bg-tr-doing/20 px-1.5 text-[10px] text-tr-doing">
                  {seatChanges[seatName(s.session)]}
                </span>
              )}
            </button>
          ))}

          <div className="ml-auto flex items-center gap-2">
            {path && body && changedFromHead && (
              <div className="flex items-center gap-1 rounded-[9px] bg-tr-panel/60 p-[3px]">
                {(["code", "changes"] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setView(m)}
                    data-on={view === m}
                    className="rounded-[7px] px-2.5 py-[5px] text-[11.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={save}
              disabled={saving || busy || !path || !dirty}
              title={busy && seat ? `${seat} is writing here right now` : "save this file"}
              className="rounded-[8px] bg-tr-ok px-3 py-1.5 text-[12px] font-semibold text-[#07130f] disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {busy && (
          <div className="tr-card px-3.5 py-2 text-[12px] text-tr-warn">
            {seat} is working in this worktree right now, so saving is refused. Review it once the
            seat lands.
          </div>
        )}
        {conflict && (
          <div className="flex items-center gap-2 rounded-[9px] border border-tr-edge bg-tr-panel/60 px-3.5 py-2 text-[12px] text-tr-warn">
            <span>This file changed on disk while you were editing it.</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setConflict(false); statRef.current = null; reload(); }}
                className="rounded-[8px] bg-tr-panel px-3 py-1.5 text-[12px] font-semibold text-tr-text"
              >
                Reload from disk
              </button>
              <button
                type="button"
                onClick={() => { setConflict(false); statRef.current = null; }}
                className="rounded-[8px] px-2.5 py-1.5 text-[12px] text-tr-muted hover:text-tr-text"
              >
                Keep my changes
              </button>
            </div>
          </div>
        )}
        {saved && !dirty && (
          <div className="px-1 text-[11.5px] text-tr-ok">Saved.</div>
        )}
        {error && <div className="tr-mono px-1 text-[12px] text-tr-danger">{error}</div>}

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-tr-edge bg-[#101013] p-1.5">
          {!path || !body ? (
            <div className="flex h-full items-center justify-center">
              <div className="tr-card-ghost max-w-[440px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
                {path
                  ? "reading…"
                  : "Pick a file in the Files column to edit it. Switch the source above to work in a seat's worktree rather than the project checkout."}
              </div>
            </div>
          ) : view === "changes" && head !== null && changedFromHead ? (
            <ChangesView
              base={head}
              value={draft}
              path={path}
              editable={!busy}
              onChange={setDraft}
              onSave={save}
            />
          ) : (
            <CodeView value={draft} path={path} editable onChange={setDraft} onSave={save} />
          )}
        </div>
        {body?.truncated && (
          <div className="px-1 text-[11.5px] text-tr-warn">Cut at 512 KB — this is the head of the file, not all of it.</div>
        )}
      </div>
    </div>
  );
}
