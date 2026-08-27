// Reading the code, in the app.
//
// The rule this view enforces: you read a seat's work AFTER it lands, not while it is being
// written. A file an agent is mid-way through writing is not something anyone should be reading as
// truth, let alone editing, so a working seat's worktree is marked as in flight and the diff is
// labelled accordingly. Editing arrives here next, gated on the same signal.
import { useEffect, useMemo, useState } from "react";
import type { HubClient, Peer } from "../../shared/api/client";
import { ProjectHeader, type Lens } from "../project/ProjectHeader";
import { fileDiff, readFile, seatState, statusLabel, writeFile, type FileBody } from "./fileApi";

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
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // ONE owner for "is this seat writing right now": herdr, asked through Rust. The UI used to guess
  // it from bus status, which is a second answer to a question that gates an edit.
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
  useEffect(() => {
    if (!seat) { setBusy(false); return; }
    let alive = true;
    const look = () => { seatState(seat).then(st => { if (alive) setBusy(st === "working"); }).catch(() => {}); };
    look();
    const iv = setInterval(look, 5_000);
    return () => { alive = false; clearInterval(iv); };
  }, [seat]);

  useEffect(() => {
    if (!path) { setBody(null); setDiff(null); setError(null); return; }
    let alive = true;
    setBody(null); setDiff(null); setError(null); setDraft(null); setSaved(null);
    readFile(project, path, seat ?? undefined)
      .then(b => { if (alive) setBody(b); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    fileDiff(project, path, seat ?? undefined)
      .then(d => { if (alive) setDiff(d); })
      .catch(() => { if (alive) setDiff(""); });
    return () => { alive = false; };
  }, [project, path, seat]);

  const sub = path
    ? `${seat ? `seat/${seat}` : "project"} · ${path}${body ? ` · ${body.bytes.toLocaleString()} bytes` : ""}`
    : "pick a file in the sidebar";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeader project={project} sub={sub} lens={lens} onLens={onLens} />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-8 pb-6">
        {/* WHICH COPY. The project checkout and a seat's worktree are different files with the
            same path, and leaving that implicit is what made "what changed" ambiguous. */}
        <div className="flex items-center gap-1">
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
          {path && body && !busy && (
            <button
              type="button"
              onClick={() => setDraft(draft === null ? body.text : null)}
              className="ml-auto rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted hover:text-tr-text"
            >
              {draft === null ? "edit" : "cancel"}
            </button>
          )}
          {path && diff && draft === null && (
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

        {/* IN FLIGHT. Not a warning for its own sake: it is the reason editing will be refused
            here, so the operator learns the rule before they meet the lock. */}
        {busy && (
          <div className="tr-card px-3.5 py-2 text-[12px] text-tr-warn">
            {seat} is working in this worktree right now, so this file cannot be edited. What you are
            reading may change under you — review it once the seat lands.
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-tr-edge bg-[#101013] p-4">
          {!path ? (
            <div className="flex h-full items-center justify-center">
              <div className="tr-card-ghost max-w-[440px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
                Pick a file in the sidebar to read it. Switch the source above to see the same path
                as a seat has it, rather than as the project checkout has it.
              </div>
            </div>
          ) : error ? (
            <div className="tr-mono text-[12px] text-tr-danger">{error}</div>
          ) : mode === "diff" && diff ? (
            <pre className="tr-mono whitespace-pre text-[12px] leading-[1.6]">
              {diff.split("\n").map((l, i) => (
                <div
                  key={i}
                  style={{
                    color: l.startsWith("+") && !l.startsWith("+++") ? "var(--color-tr-ok)"
                      : l.startsWith("-") && !l.startsWith("---") ? "var(--color-tr-danger)"
                      : l.startsWith("@@") ? "var(--color-tr-doing)"
                      : undefined,
                  }}
                >{l}</div>
              ))}
            </pre>
          ) : draft !== null ? (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                spellCheck={false}
                className="tr-mono min-h-0 flex-1 resize-none rounded-lg bg-black/30 p-3 text-[12px] leading-[1.6] outline-none"
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={saving || draft === body?.text}
                  onClick={() => {
                    if (!path) return;
                    setSaving(true); setError(null);
                    writeFile(project, path, seat ?? undefined, draft)
                      .then(sha => {
                        setSaved(sha || "unchanged");
                        setDraft(null);
                        return readFile(project, path, seat ?? undefined).then(setBody);
                      })
                      .then(() => fileDiff(project, path, seat ?? undefined).then(setDiff))
                      .catch(e => setError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setSaving(false));
                  }}
                  className="rounded-[8px] bg-tr-ok px-3 py-1.5 text-[12px] font-semibold text-[#07130f] disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                {/* Said before they click, not after: the commit is the thing that keeps their
                    tweak from being attributed to the agent whose worktree this is. */}
                <span className="text-[11.5px] text-tr-muted">
                  Saving commits this file as you, so it stays yours and not {seat ?? "the project"}&rsquo;s.
                </span>
              </div>
            </div>
          ) : body ? (
            <>
              {saved && (
                <div className="mb-3 text-[11.5px] text-tr-ok">
                  {saved === "unchanged" ? "No change to save." : `Committed as you · ${saved}`}
                </div>
              )}
              <pre className="tr-mono whitespace-pre text-[12px] leading-[1.6]">{body.text}</pre>
              {body.truncated && (
                <div className="mt-3 text-[11.5px] text-tr-warn">
                  Cut at 512 KB — this is the head of the file, not all of it.
                </div>
              )}
            </>
          ) : (
            <div className="text-[12px] text-tr-muted">reading…</div>
          )}
        </div>
      </div>
    </div>
  );
}

export { statusLabel };
