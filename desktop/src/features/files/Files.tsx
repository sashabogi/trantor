// Reading and changing the code, in the app.
//
// Two rules shape this view:
//
// 1. You read a seat's work AFTER it lands. A file an agent is part way through writing is not
//    truth, and editing it loses one of the two writes with no undo. herdr owns that signal, asked
//    through Rust, because the runner reports it there at every turn boundary.
//
// 2. Saving COMMITS, authored to you. `trantor integrate` commits a seat's dirty worktree as that
//    seat, so a tweak of yours left uncommitted would be attributed to the agent. Committing on
//    save closes that window and leaves git blame as the durable answer.
import { useEffect, useMemo, useState } from "react";
import type { HubClient, Peer } from "../../shared/api/client";
import { ProjectHeader, type Lens } from "../project/ProjectHeader";
import { readFile, readFileAtHead, seatState, writeFile, type FileBody } from "./fileApi";
import { CodeView } from "./CodeView";
import { DiffView } from "./DiffView";

type Mode = "content" | "diff";

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
  const [mode, setMode] = useState<Mode>("content");
  const [body, setBody] = useState<FileBody | null>(null);
  const [head, setHead] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    readFile(project, path, seat ?? undefined).then(setBody).catch(e => setError(e instanceof Error ? e.message : String(e)));
    readFileAtHead(project, path, seat ?? undefined).then(setHead).catch(() => setHead(""));
  };

  useEffect(() => {
    if (!path) { setBody(null); setHead(null); setError(null); return; }
    setBody(null); setHead(null); setError(null); setEditing(false); setSaved(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, path, seat]);

  const changed = head !== null && body !== null && head !== body.text;

  const save = () => {
    if (!path) return;
    setSaving(true); setError(null);
    writeFile(project, path, seat ?? undefined, draft)
      .then(sha => { setSaved(sha || "unchanged"); setEditing(false); reload(); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

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
              className="rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
            >
              {seatName(s.session)}
            </button>
          ))}

          <div className="ml-auto flex items-center gap-2">
            {path && body && !editing && (
              <button
                type="button"
                onClick={() => { setDraft(body.text); setEditing(true); setMode("content"); }}
                disabled={busy}
                title={busy ? `${seat} is writing here right now` : "edit this file"}
                className="rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted hover:text-tr-text disabled:opacity-40"
              >
                edit
              </button>
            )}
            {editing && (
              <>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || draft === body?.text}
                  className="rounded-[8px] bg-tr-ok px-3 py-1.5 text-[12px] font-semibold text-[#07130f] disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-[9px] px-2.5 py-[7px] text-[12.5px] text-tr-muted hover:text-tr-text"
                >
                  cancel
                </button>
              </>
            )}
            {path && changed && !editing && (
              <div className="flex items-center gap-1 rounded-[9px] bg-tr-panel/60 p-[3px]">
                {(["content", "diff"] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    data-on={mode === m}
                    className="rounded-[7px] px-2.5 py-[5px] text-[11.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {busy && (
          <div className="tr-card px-3.5 py-2 text-[12px] text-tr-warn">
            {seat} is working in this worktree right now, so this file cannot be edited. Review it
            once the seat lands.
          </div>
        )}
        {editing && (
          <div className="px-1 text-[11.5px] text-tr-muted">
            Saving commits this file as you, so your change stays yours and not {seat ?? "the project"}&rsquo;s.
          </div>
        )}
        {saved && !editing && (
          <div className="px-1 text-[11.5px] text-tr-ok">
            {saved === "unchanged" ? "No change to save." : `Committed as you · ${saved}`}
          </div>
        )}
        {error && <div className="tr-mono px-1 text-[12px] text-tr-danger">{error}</div>}

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-tr-edge bg-[#101013] p-1.5">
          {!path ? (
            <div className="flex h-full items-center justify-center">
              <div className="tr-card-ghost max-w-[440px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
                Pick a file in the sidebar to read it. Switch the source above to see the same path
                as a seat has it, rather than as the project checkout has it.
              </div>
            </div>
          ) : editing ? (
            <CodeView value={draft} path={path} editable onChange={setDraft} />
          ) : mode === "diff" && changed && head !== null && body ? (
            <DiffView base={head} head={body.text} path={path} />
          ) : body ? (
            <CodeView value={body.text} path={path} editable={false} />
          ) : (
            <div className="p-3 text-[12px] text-tr-muted">reading…</div>
          )}
        </div>
        {body?.truncated && (
          <div className="px-1 text-[11.5px] text-tr-warn">Cut at 512 KB — this is the head of the file, not all of it.</div>
        )}
      </div>
    </div>
  );
}
