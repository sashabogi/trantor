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
//
// 4. Open files are TABS (#5813), the model in codeTabs.ts: identity is scope+path, a plain open
//    is a PREVIEW the next open replaces, a pin makes it permanent, and the dirty dot follows the
//    draft — per Orca's split-open.ts:26-29.
import { useEffect, useRef, useState } from "react";
import { X, Pin } from "lucide-react";
import type { HubClient } from "../../shared/api/client";
import { ProjectHeader, type Lens } from "../project/ProjectHeader";
import { fileStat, readFile, readFileAtHead, seatState, writePlain, type FileBody } from "./fileApi";
import { CodeView } from "./CodeView";
import { ChangesView } from "./ChangesView";
import { decideReload, type FileStat } from "./liveReload";
import { closeTab, markDirty, markExternalMutation, openInTabs, togglePin, type CodeTab } from "./codeTabs";
import { diskSignature, externalMutationOnLoad } from "./tabGuard";
import {
  dropDocument,
  markLoaded,
  projectDocuments,
  setBaseSignature,
  setDisk,
  setDraft as storeSetDraft,
  setActiveKey as storeSetActiveKey,
  setTabs as storeSetTabs,
} from "./documents";
import { detachLspClients, isLspIndexing, isLspLive, lspPhase, onLspChange, startLsp, stopLspProject } from "./lspClient";
import { lspLanguageFor, lspServerName } from "./lspLanguage";
import { listen } from "@tauri-apps/api/event";

type ViewMode = "code" | "changes";

const baseName = (p: string) => p.split("/").pop() ?? p;

export function Files({ project, lens, onLens, path, seat }: {
  client: HubClient;
  project: string;
  lens: Lens;
  onLens: (l: Lens) => void;
  path: string | null;
  seat: string | null;
  onSeat: (s: string | null) => void;
}) {
  // Tabs, activeKey, drafts, disk text, base signatures, and loaded flags live in the
  // module-level document store (#5938) — they OUTLIVE this lens. This component is a VIEW over
  // it: read on mount, write on every change, nothing on unmount. The version counter just
  // tells React that a store mutation happened.
  const docs = projectDocuments(project);
  const [, setDocsVersion] = useState(0);
  const sync = () => setDocsVersion(v => v + 1);
  const tabs = docs.tabs;
  const activeKey = docs.activeKey;
  const setTabs = (next: CodeTab[] | ((current: CodeTab[]) => CodeTab[])) => {
    storeSetTabs(project, typeof next === "function" ? next(docs.tabs) : next);
    sync();
  };
  const setActiveKey = (key: string | null) => { storeSetActiveKey(project, key); sync(); };
  const [body, setBody] = useState<FileBody | null>(null);
  const [head, setHead] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraftState] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // The language-server status line: "rust-analyzer ready" or the honest "not installed: <name>".
  const [lspNote, setLspNote] = useState<string | null>(null);
  // The resolved scope root the language server chose — the editor's model URI is built from it.
  const [lspRoot, setLspRoot] = useState<string | null>(null);

  const activeTab = tabs.find(t => t.key === activeKey) ?? null;
  // The on-disk conflict rides the TAB (Orca open-file.ts:124-128, per-tab), not this component's
  // state: switching away and back must not forget that a file moved under unsaved work.
  const conflict = activeTab?.externalMutation === "changed";
  const activePath = activeTab?.path ?? null;
  const activeScope = activeTab?.scope ?? "project";
  const activeView = activeTab?.view ?? "code";

  // The disk stat we last acted on, and whether the editor holds unsaved work. Both live in refs
  // so the poll reads the CURRENT values without tearing the interval down every render.
  const statRef = useRef<FileStat | null>(null);
  const dirtyRef = useRef(false);
  // The editor is always live: unsaved work is simply "the draft differs from the disk".
  dirtyRef.current = body !== null && draft !== body.text;

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

  const reload = (key: string) => {
    const tab = tabs.find(t => t.key === key);
    if (!tab) return;
    const tabSeat = tab.scope === "project" ? undefined : tab.scope;
    readFile(project, tab.path, tabSeat)
      .then(b => {
        setBody(b);
        setDisk(project, key, b.text);
        const kept = docs.docs.get(key)?.draft;
        const verdict = externalMutationOnLoad({
          draft: kept ?? null,
          baseSignature: docs.docs.get(key)?.baseSignature ?? null,
          diskText: b.text,
        });
        setTabs(ts => markExternalMutation(ts, key, verdict === "moved" ? "changed" : undefined));
        const text = verdict === "moved" ? (kept ?? "") : (kept ?? b.text);
        if (verdict !== "moved") setBaseSignature(project, key, diskSignature(b.text));
        storeSetDraft(project, key, text);
        setDraftState(text);
        setTabs(ts => markDirty(ts, key, text !== b.text));
        markLoaded(project, key);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
    readFileAtHead(project, tab.path, tabSeat).then(setHead).catch(() => setHead(""));
  };

  // Open (or activate) a path, preview semantics live in codeTabs.openInTabs. Every activation
  // passes through here so the outgoing tab's draft is stashed before the swap — but ONLY a
  // draft whose document actually finished loading. Stashing before readFile resolved recorded
  // the initial "" as the tab's kept work (the 2026-09-01 empty-editor regression); a draft
  // without a completed load is not a draft, it is a loading screen.
  const stashDraft = () => {
    if (activeKey && docs.docs.get(activeKey)?.loaded) storeSetDraft(project, activeKey, draft);
  };
  const openPath = (scope: string, p: string, view: ViewMode) => {
    stashDraft();
    const { tabs: next, activeKey: nextKey } = openInTabs(tabs, activeKey, scope, p, view);
    setTabs(next);
    setActiveKey(nextKey);
  };

  const activateTab = (key: string) => {
    if (key === activeKey) return;
    stashDraft();
    setActiveKey(key);
  };

  // The Files column (AppShell) opens paths from the tree: a preview open under this scope.
  useEffect(() => {
    if (!path) return;
    openPath(seat ?? "project", path, "code");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, seat]);

  // Load the active tab's documents. body/head reset per tab; the draft survives in the store.
  useEffect(() => {
    if (!activeTab) { setBody(null); setHead(null); setError(null); setDraftState(""); setSaved(false); return; }
    setBody(null); setHead(null); setError(null); setSaved(false);
    // setDraftState, NOT setDraft: the setter below also records the value as the tab's kept
    // draft, and recording "" for a tab with nothing kept is what made reload() adopt "" over the
    // disk text — the whole file rendered as one blank line, the changes view as all-deleted
    // (0.3.91, seen on screen). The kept draft is read here, never written.
    setDraftState(docs.docs.get(activeTab.key)?.draft ?? "");
    statRef.current = null;
    reload(activeTab.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, activeTab?.key]);

  // The open file follows the disk via fs watch events instead of polling.
  // decideReload (7 legs, UNTOUCHED) decides reload vs conflict vs none.
  useEffect(() => {
    if (!activeTab) return;
    let alive = true;
    const tabPath = activeTab.path;
    const tabScope = activeTab.scope;

    const unlisten = listen<{ project: string; paths: string[] }>("file-changed", ev => {
      if (!alive || ev.payload.project !== project) return;
      const changed = ev.payload.paths;
      if (!changed.includes(tabPath)) return;
      fileStat(project, tabPath, tabScope === "project" ? undefined : tabScope)
        .then(st => {
          if (!alive) return;
          const decision = decideReload({ dirty: dirtyRef.current, lastStat: statRef.current, newStat: st });
          if (decision === "reload") {
            statRef.current = st;
            reload(activeTab.key);
          } else if (decision === "conflict") {
            // The flag rides the tab, so the bar is still there after a switch away and back.
            setTabs(ts => markExternalMutation(ts, activeTab.key, "changed"));
          } else if (statRef.current === null) {
            statRef.current = st;
          }
        })
        .catch(() => {});
    });

    return () => { alive = false; unlisten.then(u => u()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, activeTab?.key]);

  // Language server: one client per (workspace root, language), shared across tabs, started the
  // first time a served file mounts. The honest status line names the running phase, never a fake
  // "ready". Servers OUTLIVE this lens — they are stopped on project switch / idle / app exit.
  const activeLanguage = activePath ? lspLanguageFor(activePath) : null;
  const lspName = activeLanguage ? lspServerName(activeLanguage) : "";

  // Derive the status line from the shared client state; called after start and on every change.
  const updateStatus = () => {
    if (!activeLanguage) { setLspNote(null); return; }
    if (!isLspLive(activeLanguage)) { setLspNote(null); return; }
    if (isLspIndexing(activeLanguage)) {
      const phase = lspPhase(activeLanguage);
      setLspNote(phase ? `${lspName}: ${phase}` : `${lspName}…`);
    } else {
      setLspNote(`${lspName} ready`);
    }
  };

  useEffect(() => {
    if (!activeLanguage || !activePath) { setLspNote(null); setLspRoot(null); return; }
    let alive = true;
    const scope = activeScope === "project" ? null : activeScope;
    setLspNote(null);
    setLspRoot(null);
    startLsp(project, scope, activeLanguage, activePath)
      .then(({ scopeRoot }) => {
        if (!alive) return;
        setLspRoot(scopeRoot);
        updateStatus();
      })
      .catch(e => { if (alive) setLspNote(String(e)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, activeLanguage, activeScope, activePath]);

  // The phase flips (begin → "cachePriming", end → ready) notify the client; re-derive the status.
  useEffect(() => {
    if (!activeLanguage) return;
    return onLspChange(updateStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLanguage]);

  // Servers OUTLIVE the lens: on unmount only DETACH the Monaco clients. The Rust server stays so
  // a remount re-attaches to the same id instead of cold-spawning (the 0.3.101 broken-pipe bug).
  useEffect(() => () => { void detachLspClients(); }, []);

  // Project switch stops the OLD project's servers.
  const prevProjectRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevProjectRef.current;
    if (prev && prev !== project) {
      void stopLspProject(prev);
    }
    prevProjectRef.current = project;
  }, [project]);

  const setDraft = (v: string) => {
    setDraftState(v);
    if (activeKey) {
      storeSetDraft(project, activeKey, v);
      setTabs(ts => markDirty(ts, activeKey, v !== (body?.text ?? "")));
    }
  };

  // The Changes view compares HEAD against the LIVE draft — the same document the code view
  // edits — so it stays truthful through every keystroke, not just at save time.
  const changedFromHead = head !== null && head !== draft;

  const save = () => {
    // Gated on a live on-disk conflict: writing now would silently discard the newer file —
    // the bar above is the way out (reload, or keep the draft and adopt the new baseline).
    if (!activeTab || busy || conflict) return;
    setSaving(true); setError(null);
    const key = activeTab.key;
    const tabSeat = activeTab.scope === "project" ? undefined : activeTab.scope;
    writePlain(project, activeTab.path, tabSeat, draft)
      .then(() => {
        setSaved(true);
        // Our own save moved the disk: the draft is now the disk, and it is the new baseline.
        statRef.current = null;
        setBaseSignature(project, key, diskSignature(draft));
        setDisk(project, key, draft);
        setTabs(ts => markExternalMutation(ts, key, undefined));
        setTabs(ts => markDirty(ts, key, false));
        reload(key);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  // "Keep my changes" adopts the NEW disk text as the draft's baseline without touching the
  // draft: the conflict clears, and the guard stays armed for the next external move.
  const keepMyChanges = () => {
    if (!activeTab) return;
    const key = activeTab.key;
    const tabSeat = activeTab.scope === "project" ? undefined : activeTab.scope;
    readFile(project, activeTab.path, tabSeat)
      .then(b => {
        setBaseSignature(project, key, diskSignature(b.text));
        setDisk(project, key, b.text);
        setTabs(ts => markExternalMutation(ts, key, undefined));
      })
      .catch(() => {});
  };

  const dirty = body !== null && draft !== body.text;
  const sub = activePath
    ? `${activeScope === "project" ? "project" : `seat/${activeScope}`} · ${activePath}${body ? ` · ${body.bytes.toLocaleString()} bytes` : ""}`
    : "pick a file in the sidebar";
  const visibleTabs = tabs.filter(t => t.scope === (seat ?? "project"));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeader project={project} sub={sub} lens={lens} onLens={onLens} />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-8 pb-6">
        <div className="flex items-center gap-1">
          {/* WHICH COPY lives in the ModePane footer now (#5841) — one picker feeds tree, editor,
              and git. This row keeps only the view toggle and Save. */}
          <div className="ml-auto flex items-center gap-2">
            {activePath && body && changedFromHead && (
              <div className="flex items-center gap-1 rounded-[9px] bg-tr-panel/60 p-[3px]">
                {(["code", "changes"] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTabs(ts => ts.map(t => (t.key === activeKey ? { ...t, view: m } : t)))}
                    data-on={activeView === m}
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
              disabled={saving || busy || !activePath || !dirty || conflict}
              title={conflict
                ? "resolve the on-disk conflict first — saving now would discard the newer file"
                : busy && seat ? `${seat} is writing here right now` : "save this file"}
              className="rounded-[8px] bg-tr-ok px-3 py-1.5 text-[12px] font-semibold text-[#07130f] disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {/* The tab strip (#5813): one set per source, dirty dot follows the draft, pin makes a
            tab permanent, preview dies to the next open. */}
        {visibleTabs.length > 0 && (
          <div className="flex min-h-0 items-center gap-0.5 overflow-x-auto">
            {visibleTabs.map(t => (
              <div
                key={t.key}
                onClick={() => activateTab(t.key)}
                onDoubleClick={() => setTabs(ts => togglePin(ts, t.key))}
                data-on={t.key === activeKey}
                title={`${t.scope}:${t.path}${t.pinned ? " · pinned" : ""}`}
                className="group flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-[9px] border-b-2 px-2.5 py-[6px] text-[12px] text-tr-muted data-[on=true]:border-tr-doing data-[on=true]:bg-tr-panel/60 data-[on=true]:text-tr-text"
              >
                <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${t.dirty ? "bg-tr-warn" : "bg-transparent"}`}
                      data-testid={`dirty-${t.key}`} />
                <span className="tr-mono min-w-0 flex-1 truncate">{baseName(t.path)}</span>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setTabs(ts => togglePin(ts, t.key)); }}
                  title={t.pinned ? "unpin (becomes the preview again)" : "pin this tab"}
                  className={`shrink-0 rounded p-0.5 hover:text-tr-text ${t.pinned ? "text-tr-doing opacity-100" : "opacity-0 group-hover:opacity-60"}`}
                >
                  <Pin size={11} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    const { tabs: next, activeKey: nextKey } = closeTab(tabs, activeKey, t.key);
                    setTabs(next);
                    setActiveKey(nextKey);
                    dropDocument(project, t.key);
                  }}
                  title="close tab"
                  className="shrink-0 rounded p-0.5 opacity-0 hover:text-tr-text group-hover:opacity-60"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        )}

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
                onClick={() => { statRef.current = null; if (activeTab) reload(activeTab.key); }}
                className="rounded-[8px] bg-tr-panel px-3 py-1.5 text-[12px] font-semibold text-tr-text"
              >
                Reload from disk
              </button>
              <button
                type="button"
                onClick={() => { statRef.current = null; keepMyChanges(); }}
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
          {!activePath || !body ? (
            <div className="flex h-full items-center justify-center">
              <div className="tr-card-ghost max-w-[440px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
                {activePath
                  ? "reading…"
                  : "Pick a file in the pane to edit it. The scope control at the bottom of the pane switches between the project checkout and a seat's worktree."}
              </div>
            </div>
          ) : activeView === "changes" && head !== null && changedFromHead ? (
            <ChangesView
              base={head}
              value={draft}
              path={activePath}
              editable={!busy}
              onChange={setDraft}
              onSave={save}
            />
          ) : (
            <CodeView value={draft} path={activePath} root={lspRoot} editable onChange={setDraft} onSave={save} project={project} seat={seat} />
          )}
        </div>
        {body?.truncated && (
          <div className="px-1 text-[11.5px] text-tr-warn">Cut at 512 KB — this is the head of the file, not all of it.</div>
        )}
        {lspNote && (
          <div className="tr-mono px-1 text-[11px] text-tr-muted">{lspNote}</div>
        )}
      </div>
    </div>
  );
}
