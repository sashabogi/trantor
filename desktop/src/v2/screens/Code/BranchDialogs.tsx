import { useState, type ReactNode } from "react";
import { Button } from "../../ui/Button";
import { useEscape } from "../../ui/useEscape";
import { scopeBranchCreate, type GitBranch, type GitDirtySwitch, type GitScopeArg } from "./scopeGitApi";
import { errorMessage, type BranchDialogState, type ErrorHandler } from "./useBranchOps";

function Dialog({ label, children, onClose }: { label: string; children: ReactNode; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--v2-scrim)] p-5" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-label={label} className="flex w-[420px] max-w-full flex-col gap-3 rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel)] p-4 shadow-2xl">
        {children}
      </div>
    </div>
  );
}

export function CreateBranchDialog({ project, scope, sha, onClose, onCreated, onError }: {
  project: string; scope: GitScopeArg; sha?: string; onClose: () => void; onCreated: () => void; onError: ErrorHandler;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const create = () => {
    setBusy(true);
    void scopeBranchCreate(project, scope, name.trim(), sha).then(() => { onCreated(); onClose(); })
      .catch(error => onError(errorMessage(error))).finally(() => setBusy(false));
  };
  return (
    <Dialog label={sha ? `Create a branch at ${sha.slice(0, 7)}` : "Create branch"} onClose={onClose}>
      <h2 className="m-0 text-v2-title text-[var(--v2-text)]">Create a branch {sha ? `at ${sha.slice(0, 7)}` : "from HEAD"}</h2>
      <label className="text-v2-body text-[var(--v2-muted)]" htmlFor="v2-new-branch">Branch name</label>
      <input id="v2-new-branch" aria-label="New branch name" autoFocus value={name} onChange={event => setName(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && name.trim() && !busy) create(); }}
        className="rounded-md border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-2 text-v2-base text-[var(--v2-text)] outline-none" />
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabledReason={!name.trim() ? "Enter a branch name" : busy ? "Creating branch" : null} onClick={create}>Create branch</Button></div>
    </Dialog>
  );
}

function SwitchDialog({ branch, count, busy, onClose, onSwitch }: {
  branch: GitBranch; count: number; busy: boolean; onClose: () => void; onSwitch: (branch: GitBranch, dirty: GitDirtySwitch) => void;
}) {
  return <Dialog label={`Switch to ${branch.name}`} onClose={onClose}>
    <h2 className="m-0 text-v2-title text-[var(--v2-text)]">Uncommitted files</h2>
    <p className="m-0 text-v2-base leading-relaxed text-[var(--v2-text-2)]">Bring {count} changed path(s) to {branch.name}, or stash them with a message naming that branch.</p>
    <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button disabledReason={busy ? "Switching" : null} onClick={() => onSwitch(branch, "stash")}>Stash and switch</Button><Button variant="primary" disabledReason={busy ? "Switching" : null} onClick={() => onSwitch(branch, "bring")}>Bring changes</Button></div>
  </Dialog>;
}

function RenameDialog({ branch, busy, onClose, onRename }: { branch: GitBranch; busy: boolean; onClose: () => void; onRename: (name: string) => void }) {
  const [name, setName] = useState(branch.name);
  return <Dialog label={`Rename ${branch.name}`} onClose={onClose}>
    <h2 className="m-0 text-v2-title text-[var(--v2-text)]">Rename {branch.name}</h2>
    <input aria-label="New branch name" autoFocus value={name} onChange={event => setName(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter" && name.trim() && name !== branch.name && !busy) onRename(name.trim()); }}
      className="rounded-md border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-2 text-v2-base text-[var(--v2-text)] outline-none" />
    <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabledReason={!name.trim() || name === branch.name ? "Enter a new branch name" : busy ? "Renaming" : null} onClick={() => onRename(name.trim())}>Rename branch</Button></div>
  </Dialog>;
}

function DeleteDialog({ branch, unique, busy, onClose, onDelete }: {
  branch: GitBranch; unique: number; busy: boolean; onClose: () => void; onDelete: (branch: GitBranch, force: boolean) => void;
}) {
  return <Dialog label={`Delete ${branch.name}`} onClose={onClose}>
    <h2 className="m-0 text-v2-title text-[var(--v2-text)]">Delete unmerged branch?</h2>
    <p className="m-0 text-v2-base leading-relaxed text-[var(--v2-text-2)]">{branch.name} has {unique} commit{unique === 1 ? "" : "s"} that the current branch does not have. Deleting it can make those commits unreachable.</p>
    <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabledReason={busy ? "Deleting" : null} onClick={() => onDelete(branch, true)}>Delete {branch.name}</Button></div>
  </Dialog>;
}

export function BranchDialogs({ dialog, project, scope, statusCount, busy, onDismiss, onCreated, onError, onSwitch, onRename, onDelete }: {
  dialog: BranchDialogState; project: string; scope: GitScopeArg; statusCount: number; busy: boolean; onDismiss: () => void; onCreated: () => void; onError: ErrorHandler;
  onSwitch: (branch: GitBranch, dirty: GitDirtySwitch) => void; onRename: (oldName: string, newName: string) => void; onDelete: (branch: GitBranch, force: boolean) => void;
}) {
  if (!dialog) return null;
  if (dialog.kind === "create") return <CreateBranchDialog project={project} scope={scope} onClose={onDismiss} onCreated={onCreated} onError={onError} />;
  if (dialog.kind === "switch") return <SwitchDialog branch={dialog.branch} count={statusCount} busy={busy} onClose={onDismiss} onSwitch={onSwitch} />;
  if (dialog.kind === "rename") return <RenameDialog branch={dialog.branch} busy={busy} onClose={onDismiss} onRename={next => onRename(dialog.branch.name, next)} />;
  return <DeleteDialog branch={dialog.branch} unique={dialog.unique} busy={busy} onClose={onDismiss} onDelete={onDelete} />;
}
