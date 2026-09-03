import { useEffect, useReducer, useRef, useState } from "react";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import type { Event } from "@tauri-apps/api/event";
import { FileText, FolderGit2, Sparkles, X } from "lucide-react";
import { BrandGlyph } from "../../shared/Avatar";
import { notifyOnce } from "../../shared/notify";
import { genesisKickoff, projectTarget, slugProjectName } from "./genesis";
import { GENESIS_IDLE, BLANK_KICKOFF, genesisReducer, isExistsNotEmptyError, toastForTransition } from "./genesisFlow";

type StartMode = "empty" | "clone" | "adopt";
/** #6120 — the operator's two entries into a project. Blank: name + directory, wake, iterative
 *  work (kickoff says the project is empty). From a brief: a dropped or pasted PRD becomes
 *  docs/PRD.md (via `trantor new --brief`, #6113) and the kickoff convenes the crew review
 *  (#6112 wording, genesis.ts). A drop or a paste selects From a brief on its own. */
type GenesisPath = "blank" | "brief";
type ProjectNewResult = { name: string; dir: string; branch: string; hub: string; card: number | null };

/** The seams the sheet crosses, injected so a drill supplies a faithful in-memory stand-in
 *  instead of mocking the tauri modules (#6253) — the pattern ChatDeps and TerminalPane's deps
 *  already set. Production callers omit it and get the real modules. */
export type GenesisSheetDeps = {
  invoke: <T>(cmd: string, args?: InvokeArgs) => Promise<T>;
  /** The webview's drag-drop channel; resolves to the unlisten function. The handler sees the
   *  same Event envelope the real channel delivers (payload carries the drop). */
  listenDrops: (handler: (event: Event<DragDropEvent>) => void) => Promise<() => void>;
};

export const DEFAULT_GENESIS_DEPS: GenesisSheetDeps = {
  invoke: <T,>(cmd: string, args?: InvokeArgs) => invoke<T>(cmd, args),
  listenDrops: handler => getCurrentWebview().onDragDropEvent(handler),
};

export function GenesisSheet({ devRoot, onClose, onMade, onCreated, deps = DEFAULT_GENESIS_DEPS }: {
  devRoot: string;
  onClose: () => void;
  /** The project now exists on disk and is posted to the hub — add it to the sidebar's list. */
  onMade: (project: string) => void;
  /** `trantor new` succeeded: close the sheet NOW, select the project, and focus its Workspace
   *  lens. The wake that follows is a detached step (toast only) — see genesisFlow.ts's header
   *  for why this can no longer wait on it. */
  onCreated: (project: string) => void;
  /** Test seam — production callers omit it and get the real modules. */
  deps?: GenesisSheetDeps;
}) {
  const { invoke: invokeFn, listenDrops } = deps;
  const [nameInput, setNameInput] = useState("");
  const [parentOverride, setParentOverride] = useState<string | null>(null);
  const [mode, setMode] = useState<StartMode>("empty");
  const [path, setPath] = useState<GenesisPath>("blank");
  const [gitUrl, setGitUrl] = useState("");
  const [brief, setBrief] = useState("");
  const [dropName, setDropName] = useState<string | null>(null);
  const [flow, dispatch] = useReducer(genesisReducer, GENESIS_IDLE);
  const busy = flow.status === "creating";
  const nameRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLFormElement>(null);
  const slug = slugProjectName(nameInput);
  // `trantor new --dir <parent>` treats its argument as the PARENT and always appends the name,
  // so the user edits the parent directory and the resulting project path is derived from it.
  const parent = (parentOverride ?? devRoot).replace(/\/+$/, "");
  const target = projectTarget(parent, slug);
  // Drag-drop brief loading is its own failure mode, orthogonal to the create/wake flow below —
  // it can fail while the sheet is otherwise idle, which the flow's states don't model.
  const [dropError, setDropError] = useState<string | null>(null);
  const bannerError = flow.status === "error" ? flow.message : dropError;

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listenDrops(event => {
      if (!alive || event.payload.type !== "drop" || !event.payload.paths[0]) return;
      const dpr = window.devicePixelRatio || 1;
      const hit = document.elementFromPoint(event.payload.position.x / dpr, event.payload.position.y / dpr);
      if (!hit || !sheetRef.current?.contains(hit)) return;
      const dropped = event.payload.paths[0];
      void invokeFn<string>("genesis_read_brief", { path: dropped })
        .then(text => {
          if (!alive) return;
          setPath("brief");
          setBrief(text);
          setDropName(dropped.split("/").pop() ?? dropped);
          setDropError(null);
        })
        .catch(reason => { if (alive) setDropError(String(reason)); });
    }).then(stop => { if (alive) unlisten = stop; else stop(); });
    return () => { alive = false; unlisten?.(); };
  }, []);

  // The exists offer pre-fills the adopt UI with the exact parent/name that just conflicted, and
  // switches the mode toggle to it — the operator no longer has to notice and click it themselves.
  useEffect(() => {
    if (flow.status !== "exists") return;
    setMode("adopt");
    setParentOverride(flow.parent);
    setNameInput(flow.name);
  }, [flow]);

  // A paste anywhere on the sheet that is not one of the plain text inputs IS a brief (#6120):
  // it selects From a brief and fills it. Only reachable while Blank is selected — From a brief
  // has its own textarea whose onChange already owns pastes there.
  const onSheetPaste = (event: React.ClipboardEvent<HTMLFormElement>) => {
    if (path !== "brief" && !busy) {
      // SAFETY: a clipboard paste always targets the focused element inside the form, and tagName
      // is the only thing read off it — the cast names that element, never a guess.
      const target = event.target as HTMLElement;
      const text = event.clipboardData?.getData("text") ?? "";
      if (target.tagName !== "INPUT" && text) {
        event.preventDefault();
        setPath("brief");
        setBrief(text);
        setDropName(null);
        setDropError(null);
      }
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    dispatch({ type: "submit" });
    if (!slug) { dispatch({ type: "createError", message: "Give the project a name." }); return; }
    if (path === "blank" && mode === "clone" && !gitUrl.trim()) { dispatch({ type: "createError", message: "Add the Git URL to clone." }); return; }
    if (!parent) { dispatch({ type: "createError", message: "Give a parent directory to create the project under." }); return; }
    // Blank means NO brief: not an empty string that trips --brief's staging, nothing written.
    // The PRD and its kickoff wording only exist on the From-a-brief path (#6113, #6112).
    // Snap the choice now: the wake below is detached, the sheet may already be closing.
    const chosenPath = path;
    const briefText = chosenPath === "brief" ? brief : "";
    setNameInput(slug);
    setDropError(null);
    try {
      const raw = await invokeFn<string>("project_new", {
        args: {
          name: slug,
          target,
          source: chosenPath === "blank" && mode === "clone" ? gitUrl.trim() : null,
          adopt: mode === "adopt",
          brief: briefText,
        },
      });
      // SAFETY: Rust rejects non-JSON stdout, and `trantor new --json` owns this stable result shape.
      const made = JSON.parse(raw) as ProjectNewResult;
      const waking = { status: "waking" as const, project: made.name };
      dispatch({ type: "createOk", project: made.name });
      // The dialog closes HERE — right after the directory and hub record are real — instead of
      // after the wake below. That wait is what left the sheet open with a disabled Cancel (#6161).
      onMade(made.name);
      onCreated(made.name);
      const toast = toastForTransition({ status: "creating" }, waking);
      if (toast) void notifyOnce(toast);
      // Fire-and-forget: the sheet is already gone, so its own state has nothing left to show a
      // wake failure in. A toast is the only UI a background step like this can still raise.
      void invokeFn<string>("project_wake", {
        project: made.name,
        kickoff: chosenPath === "brief" ? genesisKickoff(briefText, dropName) : BLANK_KICKOFF,
      }).catch(reason => {
        const message = reason instanceof Error ? reason.message : String(reason);
        const errorToast = toastForTransition(waking, { status: "error", message });
        if (errorToast) void notifyOnce(errorToast);
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (isExistsNotEmptyError(message)) {
        dispatch({ type: "createExists", parent, name: slug, message });
      } else {
        dispatch({ type: "createError", message });
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[7vh]"
         onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      {/* #6147: while a modal sheet is open it owns every drop — this marker is what the chat
          composer's drop gate reads so a PRD dropped on the brief never becomes a chip behind
          the sheet. The sheet's own zone stays scoped by the sheetRef.contains(hit) check in
          the onDragDropEvent handler above (the Tauri channel has no event propagation). */}
      <form ref={sheetRef} onSubmit={create} onPaste={onSheetPaste} role="dialog" aria-modal="true" aria-labelledby="genesis-title"
            data-modal-sheet-open="true"
            className="tr-card flex max-h-[86vh] w-[590px] max-w-[calc(100vw-48px)] flex-col overflow-hidden p-0 shadow-2xl">
        <div className="flex items-start gap-3 border-b border-[var(--color-tr-edge)] px-5 py-4">
          <span className="rounded-lg bg-tr-doing/10 p-2 text-tr-doing"><Sparkles size={17} /></span>
          <span className="min-w-0 flex-1">
            <span id="genesis-title" className="block text-[14px] font-semibold">Start a project</span>
            <span className="mt-0.5 block text-[11.5px] text-[var(--color-tr-muted)]">Create the repo, post its brief, and wake Claude inside Trantor.</span>
          </span>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
                  className="rounded-md p-1 text-[var(--color-tr-muted)] hover:bg-white/[0.06] hover:text-[var(--color-tr-text)] disabled:opacity-40">
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          <fieldset>
            <legend className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-tr-muted)]">Start a</legend>
            <div className="tr-seg mt-1 grid grid-cols-2 gap-px">
              {(["blank", "brief"] as const).map(choice => (
                <button key={choice} type="button" aria-pressed={path === choice} data-on={path === choice}
                        onClick={() => setPath(choice)}>
                  {choice === "blank" ? "Blank" : "From a brief"}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] text-[var(--color-tr-muted)]">
              {path === "blank"
                ? "An empty project. Name it, wake the orchestrator, and tell it what to build."
                : "Drop or paste a PRD. It becomes docs/PRD.md and the crew review convenes on wake."}
            </p>
          </fieldset>

          <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-tr-muted)]">Name</label>
          <input ref={nameRef} className="tr-input mt-1 w-full" value={nameInput}
                 onChange={event => setNameInput(event.target.value)} onBlur={() => setNameInput(slug)}
                 placeholder="New Client Portal" />
          <p className="tr-mono mt-1 text-[10.5px] text-[var(--color-tr-muted)]">
            slug · {slug || "name-your-project"}
          </p>
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-tr-muted)]">Parent directory</label>
          <input className="tr-input tr-mono mt-1 w-full text-[11.5px]" value={parent}
                 onChange={event => setParentOverride(event.target.value)} aria-label="Parent directory"
                 placeholder="/Users/you/development" />
          {slug ? (
            <p className="tr-mono mt-1 text-[10.5px] text-[var(--color-tr-muted)]">
              will create <span className="text-[var(--color-tr-text)]">{target}</span>
            </p>
          ) : (
            <p className="mt-1 text-[10.5px] text-[var(--color-tr-muted)]">The project folder {slug ? target : ""} is made inside this parent; the name is appended to it.</p>
          )}

          {path === "blank" && (
            <fieldset className="mt-4">
              <legend className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-tr-muted)]">Start from</legend>
              <div className="tr-seg mt-1 grid grid-cols-3 gap-px">
                {(["empty", "clone", "adopt"] as const).map(choice => (
                  <button key={choice} type="button" aria-pressed={mode === choice} data-on={mode === choice}
                          onClick={() => setMode(choice)}>
                    {choice === "empty" ? "Empty repo" : choice === "clone" ? "Git URL" : "Existing folder"}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {mode === "clone" && (
            <input className="tr-input mt-2 w-full" value={gitUrl} onChange={event => setGitUrl(event.target.value)}
                   placeholder="https://github.com/org/repo.git" aria-label="Git URL" />
          )}
          {mode === "adopt" && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
              <FolderGit2 size={12} /> The target directory must already be a Git repository.
            </p>
          )}
          {flow.status === "exists" && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-tr-doing">
              <FolderGit2 size={12} /> That folder already exists and has files in it — adopt it to continue.
            </p>
          )}

          {path === "brief" && (
            <>
              <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-tr-muted)]">Brief</label>
              <textarea className="tr-input mt-1 min-h-32 w-full resize-y leading-relaxed" value={brief}
                        onChange={event => { setBrief(event.target.value); setDropName(null); }}
                        placeholder="What should this project become? Drop a PRD anywhere on this sheet to fill the brief." />
              <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-[var(--color-tr-muted)]">
                <FileText size={11} /> {dropName ? `Loaded ${dropName}` : "Drop a text or Markdown PRD to use its contents verbatim."}
              </p>
            </>
          )}

          <div className="tr-card-ghost mt-4 flex items-center gap-2.5 px-3 py-2.5">
            <BrandGlyph name="claude" size={15} />
            <span className="min-w-0 flex-1 text-[12px]"><span className="font-medium">Claude</span><span className="text-[var(--color-tr-muted)]"> · orchestrator</span></span>
            <span className="tr-mono text-[10px] text-[var(--color-tr-muted)]">
              {path === "brief" ? "review → build" : "empty · asks what to build"}
            </span>
          </div>
          {bannerError && <div role="alert" className="mt-3 rounded-lg bg-tr-danger/10 px-3 py-2 text-[11.5px] text-tr-danger">{bannerError}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-tr-edge)] px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy}
                  className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--color-tr-muted)] hover:bg-white/[0.06] disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={busy || !slug || !parent}
                  className="rounded-lg bg-tr-doing/20 px-3 py-1.5 text-[12px] font-semibold text-tr-doing hover:bg-tr-doing/30 disabled:opacity-40">
            {busy ? "Starting…" : flow.status === "exists" ? "Adopt this folder" : "Create & wake"}
          </button>
        </div>
      </form>
    </div>
  );
}
