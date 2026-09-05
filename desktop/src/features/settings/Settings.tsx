// SETTINGS — the things that otherwise only exist as CLI flags and JSON files.
//
// Mostly read-only, and deliberately so: hub pins and identity are written by `trantor hub set` and
// the enrolment flow, and a second writer for the same config invites the two paths to disagree.
// Showing them is still worth it — "which hub is this project on, and who am I signing as" is the
// first question when something 401s. What IS writable here is app behavior (notifications),
// because that is the app's own preference, nobody else's.
//
// The Update button below is NOT a fake affordance (the sin the first Buzz pass was warned off):
// it fronts a real in-process updater — download the release DMG, swap /Applications, relaunch.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { HubClient, knownProjects, hubForProject, editorPref, setEditorPref, isEditorPref, appUpdateCheck, appUpdateInstall } from "../../shared/api/client";
import type { AppUpdate, EditorPref } from "../../shared/api/client";
import { Avatar } from "../../shared/Avatar";
import { notificationsEnabled, setNotificationsEnabled } from "../../shared/notify";
import { AccountsPane } from "./providers/AccountsPane";
import { SettingsBoundary } from "./SettingsBoundary";
import { onboardingApi } from "../onboarding/onboardingApi";

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

import { Autonomy as AutonomyLocal } from "./Autonomy";

type SettingsProps = {
  me: string; update?: AppUpdate | null; projects?: string[]; project?: string; onReopenOnboarding?: () => void;
};

export function Settings(props: SettingsProps) {
  return (
    <SettingsBoundary area="Settings">
      <SettingsContent {...props} />
    </SettingsBoundary>
  );
}

function SettingsContent({ me, update: updateFromShell, projects = [], project = "", onReopenOnboarding }: SettingsProps) {
  const [reopening, setReopening] = useState(false);
  const reopenOnboarding = async () => {
    setReopening(true);
    try { await onboardingApi.reopen(); onReopenOnboarding?.(); } finally { setReopening(false); }
  };
  const [pane, setPane] = useState<"general" | "accounts">("general");
  const [hubs, setHubs] = useState<HubRow[]>([]);
  const [notify, setNotify] = useState(notificationsEnabled());
  const [editor, setEditor] = useState<EditorPref>(editorPref());
  const [autonomy, setAutonomy] = useState<Map<string, { client: HubClient; levels: Record<string, number> }>>(new Map());
  const [version, setVersion] = useState("");

  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);

  // The shell's launch-time check seeds this; "Check now" refreshes it on demand. One of three
  // update states is always visibly true: current / newer available / couldn't reach GitHub.
  const [update, setUpdate] = useState<AppUpdate | null>(updateFromShell ?? null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updateErr, setUpdateErr] = useState("");
  useEffect(() => { if (updateFromShell) setUpdate(updateFromShell); }, [updateFromShell]);
  const checkNow = async () => {
    setChecking(true); setUpdateErr("");
    const u = await appUpdateCheck();
    if (u) setUpdate(u); else setUpdateErr("couldn't reach GitHub — try again later");
    setChecking(false);
  };
  const installNow = async () => {
    if (!update) return;
    setInstalling(true); setUpdateErr("");
    // on success this never resolves — the app relaunches out from under us
    await appUpdateInstall(update).catch(e => {
      setUpdateErr(e instanceof Error && e.message ? e.message : String(e));
      setInstalling(false);
    });
  };

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
        const c = new HubClient(r.url);
        c.peers()
          .then(() => { if (alive) setHubs(cur => cur.map(x => x.url === r.url ? { ...x, ok: true } : x)); })
          .catch(() => { if (alive) setHubs(cur => cur.map(x => x.url === r.url ? { ...x, ok: false } : x)); });
        c.policy()
          .then(pol => { if (alive) setAutonomy(cur => new Map(cur).set(r.url, { client: c, levels: pol.autonomy })); })
          .catch(() => {});
      }
    });
    return () => { alive = false; };
  }, []);

  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="px-10 pt-8 pb-5">
        <h1 className="tr-page-title">Settings</h1>
        <p className="tr-page-sub">{pane === "accounts" ? "Provider logins, keys and live connection state." : "Identity, hubs and app behavior."}</p>
        <div className="tr-seg mt-4">
          <button type="button" data-on={pane === "general"} onClick={() => setPane("general")}>General</button>
          <button type="button" data-on={pane === "accounts"} onClick={() => setPane("accounts")}>Accounts</button>
        </div>
      </header>
      <div className="max-w-3xl flex-1 overflow-y-auto px-10 pb-8">
        {pane === "accounts" ? <AccountsPane project={project || projects[0] || ""} /> : <>
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
          <h2 className="tr-sec-title">Autonomy</h2>
          <p className="tr-sec-sub">The overseer's ladder, per project: 1 observe · 2 warn · 3 gate · 4 auto.</p>
          <div className="mt-3 flex flex-col gap-2.5">
            {hubs.map(h => {
              const pol = autonomy.get(h.url);
              if (!pol) return null;
              return (
                <div key={h.url} className="tr-card p-4">
                  <div className="tr-mono mb-2 text-[12px] text-[var(--color-tr-muted)]">{h.url.replace(/^https?:\/\//, "")}</div>
                  <div className="flex flex-col gap-1.5">
                    {["*", ...h.projects].map(proj => (
                      <div key={proj} className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-[13px]">{proj === "*" ? "default (every project)" : proj}</span>
                        <select value={pol.levels[proj] ?? pol.levels["*"] ?? 1}
                                onChange={e => {
                                  const lvl = Number(e.target.value);
                                  void pol.client.setAutonomy(proj, lvl).then(() =>
                                    setAutonomy(cur => {
                                      const next = new Map(cur);
                                      const entry = next.get(h.url)!;
                                      next.set(h.url, { ...entry, levels: { ...entry.levels, [proj]: lvl } });
                                      return next;
                                    }));
                                }}
                                className="tr-input shrink-0">
                          <option value={1}>1 observe</option>
                          <option value={2}>2 warn</option>
                          <option value={3}>3 gate</option>
                          <option value={4}>4 auto</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {![...autonomy.keys()].length && (
              <div className="tr-card-ghost flex items-center justify-center p-5 text-[13px]">Policy loads once a hub answers.</div>
            )}
          </div>
        </section>

        <section className="mb-8">

          {/* Local dials. The block above is the overseer's level — shared team state on the hub —
              so the two never claim to own the same thing. */}
          <AutonomyLocal projects={projects} />

          <h2 className="tr-sec-title">Code</h2>
          <p className="tr-sec-sub">A card's files and commits open here (the card drawer's Code section).</p>
          <div className="tr-card mt-3 flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Open code in</div>
              <div className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">
                Repos are found at <code>~/development/&lt;project&gt;</code> (override with <code>TRANTOR_DEV_ROOT</code>).
              </div>
            </div>
            <select value={editor} onChange={e => { const v = e.target.value; if (isEditorPref(v)) { setEditor(v); setEditorPref(v); } }}
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
          <div className="tr-card mt-3 flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">
                {update?.updateAvailable ? `Update available: v${update.latest}` : "Updates"}
              </div>
              <div className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">
                {installing ? "Downloading and installing — the app will relaunch itself…"
                  : update?.updateAvailable ? `You have v${update.current}. Installing replaces the app and relaunches it.`
                  : update ? `v${update.current} is the latest release.`
                  : "Ships as GitHub release DMGs; the app checks at launch and every few hours."}
                {updateErr && <span className="text-[var(--color-tr-fail)]"> {updateErr}</span>}
              </div>
            </div>
            {update?.updateAvailable ? (
              <button onClick={installNow} disabled={installing}
                className="shrink-0 rounded-lg px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
                style={{ background: "var(--color-tr-doing)" }}>
                {installing ? "Installing…" : `Update to v${update.latest}`}
              </button>
            ) : (
              <button onClick={checkNow} disabled={checking}
                className="tr-input shrink-0 disabled:opacity-60">
                {checking ? "Checking…" : "Check now"}
              </button>
            )}
          </div>
          <div className="tr-card mt-3 flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Onboarding</div>
              <div className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">
                Walk through providers, identity, autonomy and starting a project again.
              </div>
            </div>
            <button onClick={() => void reopenOnboarding()} disabled={reopening}
              className="tr-input shrink-0 disabled:opacity-60">
              {reopening ? "Opening…" : "Show onboarding again"}
            </button>
          </div>
        </section>
        </>}
      </div>
    </div>
  );
}
