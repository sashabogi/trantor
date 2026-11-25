// The project header and lens tabs from the Workspace artboard, shared by every in-project screen (#v2-F).
import type { ReactNode } from "react";
import { Code2, Columns3, Globe, LayoutPanelLeft, Network, Radio, Rss } from "lucide-react";
import type { HubClient } from "../../shared/api/client";
import { usePeers, stateOf } from "../../shared/presence";
import { useTasks } from "../../shared/tasks";
import { ProjectTile } from "../ui/ProjectTile";
import { LENS_LABEL, LENS_SCREENS, type LensScreen, type Navigate } from "../routes";

const LENS_ICON = {
  workspace: <LayoutPanelLeft size={13} aria-hidden />,
  code: <Code2 size={13} aria-hidden />,
  graph: <Network size={13} aria-hidden />,
  board: <Columns3 size={13} aria-hidden />,
  feed: <Rss size={13} aria-hidden />,
  bus: <Radio size={13} aria-hidden />,
  browser: <Globe size={13} aria-hidden />,
} as const satisfies Record<LensScreen, ReactNode>;

const CLOSED = new Set(["done", "archived", "cancelled", "rejected"]);

export function LensTabs({ lens, openCards, onNavigate }: { lens: LensScreen; openCards: number | null; onNavigate: Navigate }) {
  return (
    <div role="tablist" aria-label="Lenses" className="flex gap-0.5 overflow-x-auto border-b border-[var(--v2-edge)] px-5 pt-3">
      {LENS_SCREENS.map(l => {
        const on = l === lens;
        return (
          <button key={l} type="button" role="tab" aria-selected={on} onClick={() => onNavigate(l)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap border-0 border-b-2 bg-transparent px-[11px] py-[7px] text-[12.5px] font-medium ${
              on ? "border-[var(--v2-accent)] text-[var(--v2-text)]" : "border-transparent text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
            {LENS_ICON[l]}{LENS_LABEL[l]}
            {l === "board" && openCards != null && (
              <span className="rounded-lg bg-[var(--v2-edge)] px-1.5 text-[10px]">{openCards}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export type ProjectFrameProps = {
  client: HubClient;
  project: string;
  lens: LensScreen;
  onNavigate: Navigate;
  /** Right side of the header; screen owners add Branch, Ask the Advisor, Add seat here. */
  actions?: ReactNode;
  /** A status strip under the lens tabs (#13984). */
  notice?: ReactNode;
  children: ReactNode;
};

export function ProjectFrame({ client, project, lens, onNavigate, actions, notice, children }: ProjectFrameProps) {
  const { peers } = usePeers(client);
  const cards = useTasks(client, project);
  const live = (peers ?? []).filter(p => p.project === project && stateOf(p) !== "offline").length;
  const open = cards.filter(c => !CLOSED.has(c.status)).length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
        <ProjectTile name={project} size={34} />
        <div className="min-w-0 flex-[1_1_260px]">
          <h1 className="m-0 text-[20px] font-[650] tracking-[-0.01em]">{project}</h1>
          <div className="text-[12px] text-[var(--v2-muted)]">
            {peers == null ? "Reading seats" : `${live} ${live === 1 ? "seat" : "seats"} live`} · {open} open {open === 1 ? "card" : "cards"}
          </div>
        </div>
        {actions}
      </div>
      <LensTabs lens={lens} openCards={open} onNavigate={onNavigate} />
      {notice}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </div>
  );
}
