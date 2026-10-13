// The Graph lens (#11597): the code graph as its own top-level view, a peer of Board and Feed —
// the one lens the mode pane stands down for, so this surface carries its own ProjectHeader and
// the seat-scope picker (writing the SAME seat state the Code lens reads). REUSES GraphView, no
// fork: it renders exactly as the in-Code graph tab does.
import { useEffect, useMemo, useState } from "react";
import type { HubClient } from "../../../shared/api/client";
import { ProjectHeader, type Lens } from "../../project/ProjectHeader";
import { GraphView } from "../GraphView";
import { scopeSeats } from "../scopeSeats";
import { graphApiFor, type GraphApi } from "./graphApi";

export function GraphLens({ client, project, lens, onLens, seat, onSeat, onOpenFile, api }: {
  client: HubClient;
  project: string;
  lens: Lens;
  onLens: (l: Lens) => void;
  seat: string | null;
  onSeat: (s: string | null) => void;
  /** A file card opens in the Code lens on that file's tab (AppShell's open-into-Code). */
  onOpenFile: (path: string) => void;
  /** Injected by the drill; the app builds it from the hub client, as Files.tsx does. */
  api?: GraphApi;
}) {
  const graphApi = useMemo(() => api ?? graphApiFor(client), [api, client]);

  // The seats of this project — the scope chips. Same peers poll every lens runs.
  const [seats, setSeats] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { client.peers().then(ps => { if (alive) setSeats(scopeSeats(ps, project)); }).catch(() => {}); };
    load();
    const iv = setInterval(load, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [client, project]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="graph-lens">
      <ProjectHeader project={project} sub={seat ? `seat/${seat} · graph` : "the project checkout · graph"} lens={lens} onLens={onLens} />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-8 pb-6">
        <div className="flex min-h-0 items-center">
          <div className="tr-seg" data-testid="graph-scope" role="tablist" aria-label="Graph scope">
            <button type="button" data-on={seat === null} onClick={() => onSeat(null)}>project</button>
            {seats.map(s => (
              <button key={s} type="button" data-on={seat === s} onClick={() => onSeat(s)}>{`seat/${s}`}</button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-tr-edge bg-[#101013] p-1.5">
          <GraphView key={project} project={project} seat={seat} onOpen={onOpenFile} api={graphApi} />
        </div>
      </div>
    </div>
  );
}
