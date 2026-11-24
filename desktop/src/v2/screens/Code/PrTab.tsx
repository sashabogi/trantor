// A pull request tab (#13988): reads the seat's own git state, so it works whichever scope is selected.
import type { HubClient } from "../../../shared/api/client";
import { useTasks } from "../../../shared/tasks";
import { PullRequestView } from "./PullRequestView";
import { NotWiredBlock } from "./parts";
import { statusSignature } from "./SourceControlTab";
import { useSeatDiff } from "./usePatch";
import { useScopeGit } from "./useScopeGit";

export function PrTab({ client, project, seat, onAddToChat }: { client: HubClient; project: string; seat: string; onAddToChat: (text: string) => void }) {
  const { state } = useScopeGit(project, seat);
  const cards = useTasks(client, project);
  const snap = state.kind === "ok" ? state.snap : null;
  const diff = useSeatDiff(project, seat, !!snap, snap ? statusSignature(snap) : "");
  if (state.kind === "error") return <div className="p-4"><NotWiredBlock title={`${seat} has no worktree to read`} line={state.reason} /></div>;
  if (!snap) return <div className="p-4 text-[12.5px] text-[var(--v2-muted)]">Reading {seat}</div>;
  return <PullRequestView seat={seat} snap={snap} diff={diff} cards={cards} onAddToChat={onAddToChat} />;
}
