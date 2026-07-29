// SETTINGS — the things that currently only exist as CLI flags and JSON files.
//
// Read-only for now, and deliberately so: hub pins and identity are written by `trantor hub set` and
// the enrolment flow, and a second writer for the same config invites the two paths to disagree.
// Showing them is still worth it — "which hub is this project on, and who am I signing as" is the
// first question when something 401s.
import { useEffect, useState } from "react";
import { knownProjects, hubForProject } from "../../shared/api/client";

export function Settings({ me }: { me: string }) {
  const [rows, setRows] = useState<Array<[string, string]>>([]);

  useEffect(() => {
    knownProjects().then(async ps => {
      const out: Array<[string, string]> = [];
      for (const p of ps) out.push([p, await hubForProject(p)]);
      setRows(out);
    });
  }, []);

  const remote = rows.filter(([, u]) => !u.includes("127.0.0.1") && !u.includes("localhost"));

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[var(--color-tr-edge)] px-5 py-3">
        <h1 className="text-base font-semibold">settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-5 text-sm">
        <section className="mb-6">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-tr-muted)]">identity</div>
          <div className="rounded-lg border border-[var(--color-tr-edge)] bg-[var(--color-tr-panel)] p-3">
            <div>signing as <span className="font-medium">{me}</span></div>
            <div className="mt-1 text-[11px] text-[var(--color-tr-muted)]">
              Key lives in ~/.agent-bus/keys and never leaves the Rust side — the webview never sees it.
              Change with <code>RELAY_OWNER_IDENTITY</code>.
            </div>
          </div>
        </section>

        <section className="mb-6">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-tr-muted)]">
            hub routing · {remote.length} remote / {rows.length} pinned
          </div>
          <div className="overflow-hidden rounded-lg border border-[var(--color-tr-edge)]">
            {rows.map(([p, u]) => (
              <div key={p} className="flex items-center gap-3 border-b border-[var(--color-tr-edge)] bg-[var(--color-tr-panel)] px-3 py-2 last:border-0">
                <span className="w-48 shrink-0 truncate">{p}</span>
                <span className="truncate text-[11px] text-[var(--color-tr-muted)]">{u}</span>
                <span className="ml-auto shrink-0 text-[11px]"
                      style={{ color: u.includes("127.0.0.1") ? "var(--color-tr-muted)" : "var(--color-tr-ok)" }}>
                  {u.includes("127.0.0.1") ? "local" : "remote"}
                </span>
              </div>
            ))}
            {!rows.length && <div className="bg-[var(--color-tr-panel)] px-3 py-2 text-[var(--color-tr-muted)]">No pins. Use <code>trantor hub set</code>.</div>}
          </div>
        </section>

        <section>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-tr-muted)]">notifications</div>
          <div className="rounded-lg border border-[var(--color-tr-edge)] bg-[var(--color-tr-panel)] p-3 text-[var(--color-tr-muted)]">
            Fires for direct messages to you, verify gates opening, and crew seats going offline.
            Broadcasts, card moves and presence are excluded on purpose — a notification for
            everything is a notification for nothing.
          </div>
        </section>
      </div>
    </div>
  );
}
