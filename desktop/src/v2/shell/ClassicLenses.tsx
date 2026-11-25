// Graph, Feed, Bus and Messages reuse the classic components inside 2.0 chrome until they get
// their own screens; they are imported, never forked (#v2-F).
import { useState } from "react";
import type { HubClient } from "../../shared/api/client";
import type { Lens } from "../../features/project/ProjectHeader";
import { GraphLens } from "../../features/code/graph/GraphLens";
import { Feed } from "../../features/feed/Feed";
import { Conversation } from "../../features/chat/Conversation";
import { Messages } from "../../features/messages/Messages";
import { Play } from "lucide-react";
import { ProjectTile } from "../ui/ProjectTile";
import { IconButton } from "../ui/IconButton";
import type { LensScreen, Navigate } from "../routes";
import { landingLens } from "./shellMode";

export type ClassicLensProps = { client: HubClient; project: string; me: string; lens: Exclude<LensScreen, "workspace" | "code" | "board">; onNavigate: Navigate };

/** #13984 drill: the classic components draw their own ProjectHeader (title + lens row) under the 2.0 tabs;
 *  theme.css hides exactly that header inside this wrapper, leaving each lens's own filters. */
export function ClassicLens(p: ClassicLensProps) {
  return <div data-v2-embed className="flex min-h-0 flex-1 flex-col"><ClassicLensBody {...p} /></div>;
}

function ClassicLensBody({ client, project, me, lens, onNavigate }: ClassicLensProps) {
  const [seat, setSeat] = useState<string | null>(null);
  const onLens = (l: Lens) => onNavigate(l);
  if (lens === "graph") {
    return <GraphLens client={client} project={project} lens="graph" onLens={onLens} seat={seat} onSeat={setSeat} onOpenFile={() => onNavigate("code")} />;
  }
  if (lens === "feed") return <Feed client={client} project={project} lens="feed" onLens={onLens} />;
  // The Bus lens: it needs the signed identity before the conversation can be read.
  if (!me) return <NotWired title="Bus" line="Waiting for the signed identity before the bus can be read." />;
  return <Conversation client={client} project={project} me={me} lens="bus" onLens={onLens} />;
}

export function NotWired({ title, line }: { title: string; line: string }) {
  return (
    <div className="px-5 py-6">
      <h2 className="m-0 text-v2-title font-semibold">{title}</h2>
      <p className="mt-1 text-v2-base text-[var(--v2-muted)]">{line}</p>
    </div>
  );
}

export function MessagesLens({ client, me }: { client: HubClient; me: string }) {
  if (!me) return <NotWired title="Messages" line="Waiting for the signed identity before messages can be read." />;
  return <Messages client={client} me={me} />;
}

export function AllProjects({ projects, live, onNavigate, onStartProject, onWake }: {
  projects: string[]; live: string[]; onNavigate: Navigate; onStartProject?: () => void;
  /** #14271: Start on a project with no live orchestrator. */
  onWake?: (project: string) => void;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-3">
        <h1 className="m-0 flex-1 text-v2-heading font-[650]">All projects</h1>
        {onStartProject && (
          <button type="button" onClick={onStartProject} title="Create a project and wake its orchestrator (⌘N)"
            className="rounded-lg border-0 bg-[var(--v2-accent)] px-3 py-1.5 text-v2-base font-semibold text-[var(--v2-ink)]">
            Start a project
          </button>
        )}
      </div>
      <p className="mt-1 text-v2-body text-[var(--v2-muted)]">{projects.length} known · {live.length} with live sessions</p>
      <ul className="mt-4 grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 p-0">
        {projects.map(p => (
          <li key={p} className="group relative">
            <button type="button" onClick={() => onNavigate(landingLens(), p)}
              className="v2-hover flex w-full items-center gap-2.5 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)] p-2 text-left text-v2-base text-[var(--v2-text)]">
              <ProjectTile name={p} size={26} />
              <span className="min-w-0 flex-1 truncate">{p}</span>
              {live.includes(p) && <span role="img" aria-label="live" title="Has a live session" className="h-[7px] w-[7px] rounded-full bg-[var(--v2-accent)]" />}
            </button>
            {onWake && !live.includes(p) && (
              <IconButton label={`Start ${p}`} title="Start the orchestrator" size={24} onClick={() => onWake(p)}
                className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                <Play size={12} aria-hidden />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {!projects.length && <p className="text-v2-base text-[var(--v2-muted)]">No projects pinned. Run trantor hub set &lt;project&gt; &lt;url&gt;</p>}
    </div>
  );
}
