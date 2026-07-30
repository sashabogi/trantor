// SETTINGS — the things that otherwise only exist as CLI flags and JSON files.
//
// Mostly read-only, and deliberately so: hub pins and identity are written by `trantor hub set` and
// the enrolment flow, and a second writer for the same config invites the two paths to disagree.
// Showing them is still worth it — "which hub is this project on, and who am I signing as" is the
// first question when something 401s. What IS writable here is app behavior (notifications),
// because that is the app's own preference, nobody else's.
//
// No fake affordances: Buzz shows an auto-updater and compute sharing; we don't have those, so
// there is no button pretending we do. About says how updates actually arrive.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { HubClient, knownProjects, hubForProject, editorPref, setEditorPref } from "../../shared/api/client";
import type { EditorPref } from "../../shared/api/client";
import { Avatar } from "../../shared/Avatar";
import { notificationsEnabled, setNotificationsEnabled } from "../../shared/notify";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
            className="relative h-6 w-10 shrink-0 rounded-full transition-colors"
            style={{ background: on ? "var(--color-tr-ok)" : "rgba(255,255,255,0.12)" }}>
      <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
            style={{ left: on ? 18 : 2 }} />
    </button>
  );
}

type HubRow = { url: string; projects: string[]; ok: boolean | null };

export function Settings({ me }: { me: string }) {
  const [hubs, setHubs] = useState<HubRow[]>([]);
  const [notify, setNotify] = useState(notificationsEnabled());
  const [editor, setEditor] = useState<EditorPref>(editorPref());
  const [version, setVersion] = useState("");

  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);

  useEffect(() => {
    let alive = true;
    knownProjects().then(async ps => {
      const byUrl = new Map<string, string[]>();
      for (const p of ps) {
        const u = await hubForProject(p);
        (byUrl.get(u) ?? byUrl.set(u, []).get(u)!).push(p);
      }
      const rows: HubRow[] = [...byUrl.entries()].map(([url, projects]) => ({ url, projects, ok: null }));
      if (alive) setHubs(rows);
      // reachability is a live fact, not a config value — probe each hub's /health
      for (const r of rows) {
        new HubClient(r.url).peers()
          .then(() => { if (alive) setHubs(cur => cur.map(x => x.url === r.url ? { ...x, ok: true } : x)); })
          .catch(() => { if (alive) setHubs(cur => cur.map(x => x.url === r.url ? { ...x, ok: false } : x)); });
      }
    });
    return () => { alive = false; };
  }, []);

  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="px-10 pt-8 pb-5">
        <h1 className="tr-page-title">Settings</h1>
        <p className="tr-page-sub">Identity, hubs and app behavior.</p>
      </header>
      <div className="max-w-3xl flex-1 overflow-y-auto px-10 pb-8">
        <section className="mb-8">
          <h2 className="tr-sec-title">Identity</h2>
          <p className="tr-sec-sub">Every request this app makes is signed as you.</p>
          <div className="tr-card mt-3 flex items-center gap-4 p-4">
            <Avatar name={me} size={44} />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium">{me}</div>
              <div className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">
                Key lives in <code>~/.agent-bus/keys</code> and never leaves the Rust side — the webview
                never sees it. Change with <code>RELAY_OWNER_IDENTITY</code>.
              </div>
            </div>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="tr-sec-title">Hubs</h2>
          <p className="tr-sec-sub">A project lives on exactly one hub. Pins are written by <code>trantor hub set</code>.</p>
          <div className="mt-3 flex flex-col gap-2.5">
            {hubs.map(h => (
              <div key={h.url} className="tr-card p-4">
                <div className="flex items-center gap-2.5">
                  <span className="tr-dot"
                        style={{ background: h.ok === null ? "var(--color-tr-muted)" : h.ok ? "var(--color-tr-ok)" : "var(--color-tr-fail)" }} />
                  <span className="tr-mono text-[13px]">{h.url.replace(/^https?:\/\//, "")}</span>
                  <span className="ml-auto text-[11px] text-[var(--color-tr-muted)]">
                    {h.ok === null ? "checking…" : h.ok ? "reachable" : "unreachable"}
                    {" · "}{h.url.includes("127.0.0.1") || h.url.includes("localhost") ? "this machine" : "remote"}
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {h.projects.map(p => <span key={p} className="tr-chip">{p}</span>)}
                </div>
              </div>
            ))}
            {!hubs.length && (
              <div className="tr-card-ghost flex items-center justify-center p-6 text-[13px]">
                No pins yet — <code className="mx-1">trantor hub set &lt;project&gt; &lt;url&gt;</code>
              </div>
            )}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="tr-sec-title">Notifications</h2>
          <p className="tr-sec-sub">Native, and deliberately narrow — a notification for everything is a notification for nothing.</p>
          <div className="tr-card mt-3 flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Notify me when something needs a human</div>
              <div className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">
                Direct messages to you, verify gates opening, and crew seats going offline.
                Broadcasts, card moves and presence never interrupt.
              </div>
            </div>
            <Toggle on={notify} onChange={v => { setNotify(v); setNotificationsEnabled(v); }} />
          </div>
        </section>

        <section className="mb-8">
          <h2 className="tr-sec-title">Code</h2>
          <p className="tr-sec-sub">A card's files and commits open here (the card drawer's Code section).</p>
          <div className="tr-card mt-3 flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Open code in</div>
              <div className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">
                Repos are found at <code>~/development/&lt;project&gt;</code> (override with <code>TRANTOR_DEV_ROOT</code>).
              </div>
            </div>
            <select value={editor} onChange={e => { const v = e.target.value as EditorPref; setEditor(v); setEditorPref(v); }}
                    className="tr-input shrink-0">
              <option value="default">System default</option>
              <option value="vscode">VS Code</option>
              <option value="cursor">Cursor</option>
              <option value="zed">Zed</option>
              <option value="reveal">Reveal in Finder</option>
            </select>
          </div>
        </section>

        <section>
          <h2 className="tr-sec-title">About</h2>
          <p className="tr-sec-sub">Trantor Desktop{version ? ` · v${version}` : ""}</p>
          <div className="tr-card mt-3 p-4 text-[12px] text-[var(--color-tr-muted)]">
            Updates ship through the repo for now — rebuild with <code>npm run tauri build</code>.
            An auto-updater arrives with the first packaged release.
          </div>
        </section>
      </div>
    </div>
  );
}
