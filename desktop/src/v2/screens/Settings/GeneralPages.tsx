// General, Notifications and About: the classic behaviour behind each control, in 2.0 chrome (#13994).
import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { appUpdateCheck, appUpdateInstall, editorPref, isEditorPref, setEditorPref, type AppUpdate, type EditorPref } from "../../../shared/api/client";
import { backgroundOnly, notificationsEnabled, setBackgroundOnly, setNotificationsEnabled } from "../../../shared/notify";
import { onboardingApi } from "../../../features/onboarding/onboardingApi";
import { Button } from "../../ui/Button";
import { Section } from "../../ui/Section";
import { Select } from "../../ui/Select";
import { Toggle } from "../../ui/Toggle";
import { backToClassic } from "../../toggle";

export function Row({ title, body, children }: { title: string; body: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-[var(--v2-edge)] px-[14px] py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--v2-text)]">{title}</div>
        <div className="mt-0.5 text-[12px] text-[var(--v2-muted)]">{body}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function OpenCodeIn() {
  const [editor, setEditor] = useState<EditorPref>(editorPref());
  return (
    <Row title="Open code in" body="Repos are found at ~/development/<project> (override with TRANTOR_DEV_ROOT).">
      <Select aria-label="Open code in" value={editor}
        onChange={e => { const v = e.target.value; if (isEditorPref(v)) { setEditor(v); setEditorPref(v); } }}>
        <option value="default">System default</option>
        <option value="vscode">VS Code</option>
        <option value="cursor">Cursor</option>
        <option value="zed">Zed</option>
        <option value="reveal">Reveal in Finder</option>
      </Select>
    </Row>
  );
}

export function UpdateRow() {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState("");
  const check = async () => {
    setChecking(true); setErr("");
    const u = await appUpdateCheck();
    if (u) setUpdate(u); else setErr("couldn't reach GitHub, try again later");
    setChecking(false);
  };
  useEffect(() => { void check(); }, []);
  const install = async () => {
    if (!update) return;
    setInstalling(true); setErr("");
    await appUpdateInstall(update).catch(e => { setErr(e instanceof Error && e.message ? e.message : String(e)); setInstalling(false); });
  };
  const available = update?.updateAvailable;
  const body = installing ? "Downloading and installing; the app will relaunch itself."
    : available ? `You have v${update.current}. Installing replaces the app and relaunches it.`
    : update ? `v${update.current} is the latest release.` : "Ships as GitHub release DMGs; the app checks at launch and every few hours.";
  return (
    <Row title={available ? `Update available: v${update.latest}` : "Updates"} body={<>{body}{err && <span className="text-[var(--v2-bad)]"> {err}</span>}</>}>
      {available
        ? <Button variant="primary" onClick={() => void install()} disabledReason={installing ? "Installing" : null}>{installing ? "Installing…" : `Update to v${update.latest}`}</Button>
        : <Button onClick={() => void check()} disabledReason={checking ? "Checking" : null}>{checking ? "Checking…" : "Check now"}</Button>}
    </Row>
  );
}

function OnboardingRow() {
  const [busy, setBusy] = useState(false);
  const reopen = async () => {
    setBusy(true);
    try { await onboardingApi.reopen(); } finally { setBusy(false); }
  };
  return (
    <Row title="Onboarding" body="Walk through providers, identity, autonomy and starting a project again.">
      <Button onClick={() => void reopen()} disabledReason={busy ? "Opening" : null}>{busy ? "Opening…" : "Show onboarding again"}</Button>
    </Row>
  );
}

/** #13984 drill: the operator found no way back; the account menu was the only door, so Settings has one too. */
export function BackToClassicRow({ onBack = backToClassic }: { onBack?: () => void }) {
  return (
    <Row title="Back to classic" body="Switch this app back to the classic interface. Your projects and settings stay as they are.">
      <Button onClick={onBack}>Back to classic</Button>
    </Row>
  );
}

export function GeneralPage({ onBackToClassic }: { onBackToClassic?: () => void }) {
  return <Section title="General" sub="App behaviour on this machine." flush><OpenCodeIn /><UpdateRow /><OnboardingRow /><BackToClassicRow onBack={onBackToClassic} /></Section>;
}

export function NotificationsPage() {
  const [on, setOn] = useState(notificationsEnabled());
  const [bg, setBg] = useState(backgroundOnly());
  return (
    <Section title="Notifications" flush sub="Native, and deliberately narrow: a notification for everything is a notification for nothing.">
      <Row title="Notify me when something needs a human" body="Direct messages to you, verify gates opening, and crew seats going offline. Broadcasts, card moves and presence never interrupt.">
        <Toggle label="Notify me when something needs a human" on={on}
          onToggle={() => { setOn(!on); setNotificationsEnabled(!on); }} />
      </Row>
      <Row title="Only when Trantor is in the background" body="Skip the notification while this window is open and in front of you.">
        <Toggle label="Only when Trantor is in the background" on={bg}
          onToggle={() => { setBg(!bg); setBackgroundOnly(!bg); }} />
      </Row>
    </Section>
  );
}

export function AboutPage() {
  const [version, setVersion] = useState("");
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  return (
    <Section title="About" flush sub={`Trantor Desktop${version ? ` · v${version}` : ""}`}>
      <UpdateRow />
    </Section>
  );
}
