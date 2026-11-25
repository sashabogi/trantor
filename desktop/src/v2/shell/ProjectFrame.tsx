// The project header and lens tabs from the Workspace artboard, shared by every in-project screen (#v2-F).
import type { ReactNode } from "react";
import { Code2, Columns3, LayoutPanelLeft, Network, Radio, Rss } from "lucide-react";
import type { HubClient } from "../../shared/api/client";
import { usePeers, stateOf } from "../../shared/presence";
import { useTasks } from "../../shared/tasks";
import { ProjectTile } from "../ui/ProjectTile";
import { LENS_LABEL, LENS_SCREENS, type LensScreen, type Navigate } from "../routes";
import { MODE_CONFIG, useShellMode } from "./shellMode";
import { CompactHeaderBand, HeaderBand } from "./HeaderBand";

const LENS_ICON = {
  workspace: <LayoutPanelLeft size={13} aria-hidden />,
  code: <Code2 size={13} aria-hidden />,
  graph: <Network size={13} aria-hidden />,
  board: <Columns3 size={13} aria-hidden />,
  feed: <Rss size={13} aria-hidden />,
  bus: <Radio size={13} aria-hidden />,
} as const satisfies Record<LensScreen, ReactNode>;

const CLOSED = new Set(["done", "archived", "cancelled", "rejected"]);

export function LensTabs({ lens, openCards, onNavigate, order = LENS_SCREENS, compact, summary }: {
  lens: LensScreen; openCards: number | null; onNavigate: Navigate;
  /** Tabs left to right; a mode may put its own lens first (#14070). */
  order?: readonly LensScreen[];
  /** The tabs row is the whole project header: less padding, the summary at its right end. */
  compact?: boolean;
  summary?: ReactNode;
}) {
  return (
    <div role="tablist" aria-label="Lenses" className={`flex items-center gap-0.5 overflow-x-auto border-b border-[var(--v2-edge)] ${compact ? "px-3 pt-1" : "px-5 pt-3"}`}>
      {order.map(l => {
        const on = l === lens;
        return (
          <button key={l} type="button" role="tab" aria-selected={on} onClick={() => onNavigate(l)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap border-0 border-b-2 bg-transparent px-[11px] py-[7px] text-v2-base font-medium ${
              on ? "border-[var(--v2-accent)] text-[var(--v2-text)]" : "border-transparent text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
            {LENS_ICON[l]}{LENS_LABEL[l]}
            {l === "board" && openCards != null && (
              <span className="rounded-lg bg-[var(--v2-edge)] px-1.5 text-v2-micro">{openCards}</span>
            )}
          </button>
        );
      })}
      {summary != null && <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap pl-3 text-v2-body text-[var(--v2-muted)]">{summary}</div>}
    </div>
  );
}

export type ProjectFrameProps = {
  client: HubClient;
  project: string;
  lens: LensScreen;
  onNavigate: Navigate;
  /** #14256: screen actions sit beside the lens tabs to preserve the overview's single row. */
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
  const { lenses, compactHeader } = MODE_CONFIG[useShellMode()];
  const summary = `${peers == null ? "Reading seats" : `${live} ${live === 1 ? "seat" : "seats"} live`} · ${open} open ${open === 1 ? "card" : "cards"}`;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!compactHeader && (
        <div className="flex h-16 shrink-0 items-center gap-3 px-5 pt-4">
          <div className="flex w-44 min-w-0 shrink-0 items-center gap-3 xl:w-56">
            <ProjectTile name={project} size={34} />
            <div className="min-w-0">
              <h1 className="m-0 truncate text-v2-heading font-[650] tracking-[-0.01em]">{project}</h1>
              <div className="truncate text-v2-body text-[var(--v2-muted)]" title={summary}>{summary}</div>
            </div>
          </div>
          <HeaderBand key={`${client.baseUrl}:${project}`} client={client} project={project} onNavigate={onNavigate} />
        </div>
      )}
      <LensTabs lens={lens} openCards={open} onNavigate={onNavigate} order={lenses} compact={compactHeader}
        summary={compactHeader ? <><CompactHeaderBand key={`${client.baseUrl}:${project}`} client={client} project={project} onNavigate={onNavigate} />{actions}</> : actions} />
      {notice}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </div>
  );
}
