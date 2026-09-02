import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FileText, FolderGit2, Sparkles, X } from "lucide-react";
import { BrandGlyph } from "../../shared/Avatar";
import { genesisKickoff, projectTarget, slugProjectName } from "./genesis";

type StartMode = "empty" | "clone" | "adopt";
type ProjectNewResult = { name: string; dir: string; branch: string; hub: string; card: number | null };

export function GenesisSheet({ devRoot, onClose, onMade, onWoken }: {
  devRoot: string;
  onClose: () => void;
  onMade: (project: string) => void;
  onWoken: (project: string) => void;
}) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState(devRoot);
  const [targetEdited, setTargetEdited] = useState(false);
  const [mode, setMode] = useState<StartMode>("empty");
  const [gitUrl, setGitUrl] = useState("");
  const [brief, setBrief] = useState("");
  const [dropName, setDropName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent(event => {
      if (!alive || event.payload.type !== "drop" || !event.payload.paths[0]) return;
      const path = event.payload.paths[0];
      void invoke<string>("genesis_read_brief", { path })
        .then(text => {
          if (!alive) return;
          setBrief(text);
          setDropName(path.split("/").pop() ?? path);
          setError(null);
        })
        .catch(reason => { if (alive) setError(String(reason)); });
    }).then(stop => { if (alive) unlisten = stop; else stop(); });
    return () => { alive = false; unlisten?.(); };
  }, []);

  const changeName = (raw: string) => {
    const slug = slugProjectName(raw);
    setName(slug);
    if (!targetEdited) setTarget(projectTarget(devRoot, slug));
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name) { setError("Give the project a name."); return; }
    if (mode === "clone" && !gitUrl.trim()) { setError("Add the Git URL to clone."); return; }
    setBusy(true);
    setError(null);
    try {
      const raw = await invoke<string>("project_new", {
        args: {
          name,
          target,
          source: mode === "clone" ? gitUrl.trim() : null,
          adopt: mode === "adopt",
          brief,
        },
      });
      // SAFETY: Rust rejects non-JSON stdout, and `trantor new --json` owns this stable result shape.
      const made = JSON.parse(raw) as ProjectNewResult;
      onMade(made.name);
      await invoke<string>("project_wake", {
        project: made.name,
        kickoff: genesisKickoff(brief),
      });
      onWoken(made.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[7vh]"
         onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form onSubmit={create} role="dialog" aria-modal="true" aria-labelledby="genesis-title"
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
          <label className="block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-tr-muted)]">Name</label>
          <input ref={nameRef} className="tr-input mt-1 w-full" value={name}
                 onChange={event => changeName(event.target.value)} placeholder="new-client-portal" />
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-tr-muted)]">Target directory</label>
          <input className="tr-input tr-mono mt-1 w-full text-[11.5px]" value={target}
                 onChange={event => { setTargetEdited(true); setTarget(event.target.value); }} />
          <p className="mt-1 text-[10.5px] text-[var(--color-tr-muted)]">Under your development root by default; edit it before creating if this project lives elsewhere.</p>

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
          {mode === "clone" && (
            <input className="tr-input mt-2 w-full" value={gitUrl} onChange={event => setGitUrl(event.target.value)}
                   placeholder="https://github.com/org/repo.git" aria-label="Git URL" />
          )}
          {mode === "adopt" && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
              <FolderGit2 size={12} /> The target directory must already be a Git repository.
            </p>
          )}

          <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-tr-muted)]">Brief</label>
          <textarea className="tr-input mt-1 min-h-32 w-full resize-y leading-relaxed" value={brief}
                    onChange={event => { setBrief(event.target.value); setDropName(null); }}
                    placeholder="What should this project become? Drop a PRD anywhere on this sheet to fill the brief." />
          <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-[var(--color-tr-muted)]">
            <FileText size={11} /> {dropName ? `Loaded ${dropName}` : "Drop a text or Markdown PRD to use its contents verbatim."}
          </p>

          <div className="tr-card-ghost mt-4 flex items-center gap-2.5 px-3 py-2.5">
            <BrandGlyph name="claude" size={15} />
            <span className="min-w-0 flex-1 text-[12px]"><span className="font-medium">Claude</span><span className="text-[var(--color-tr-muted)]"> · orchestrator</span></span>
            <span className="tr-mono text-[10px] text-[var(--color-tr-muted)]">recap → plan</span>
          </div>
          {error && <div role="alert" className="mt-3 rounded-lg bg-tr-danger/10 px-3 py-2 text-[11.5px] text-tr-danger">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-tr-edge)] px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy}
                  className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--color-tr-muted)] hover:bg-white/[0.06] disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={busy || !name || !target}
                  className="rounded-lg bg-tr-doing/20 px-3 py-1.5 text-[12px] font-semibold text-tr-doing hover:bg-tr-doing/30 disabled:opacity-40">
            {busy ? "Starting…" : "Create & wake"}
          </button>
        </div>
      </form>
    </div>
  );
}
