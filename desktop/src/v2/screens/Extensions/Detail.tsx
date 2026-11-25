// Right pane: the selected Open VSX extension, install controls (disabled with the reason), facts, README (#13993).
import { useEffect, useState } from "react";
import type { HubClient, Peer } from "../../../shared/api/client";
import { Button, Checkbox, Chip, Section } from "../..";
import { useExtDetail } from "./hooks";
import type { Ext, ExtDetail } from "./openvsx";
import { formatCount, IconTile, INSTALL_REASON } from "./Results";

const PIN_REASON = "A version change is a card with a drill (doctrine 9); pinning opens with installs (#13985)";
const SEAT_REASON = "Seat installs open after the extension-host spike (#13985)";

function usePeers(client: HubClient): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    let alive = true;
    client.peers().then(p => { if (alive) setPeers(p.filter(x => x.kind !== "tool")); }).catch(() => {});
    return () => { alive = false; };
  }, [client]);
  return peers;
}

export function Detail({ client, ext }: { client: HubClient; ext: Ext | null }) {
  const { detail, readme, error } = useExtDetail(ext);
  const peers = usePeers(client);
  if (!ext) {
    return <section aria-label="Extension detail" className="flex w-[380px] shrink-0 items-center justify-center p-6 text-v2-base text-[var(--v2-muted)]">Select an extension to see its details.</section>;
  }
  return (
    <section aria-label={ext.displayName} className="flex w-[380px] shrink-0 flex-col gap-3 overflow-y-auto p-4">
      <header className="flex items-start gap-3">
        <IconTile ext={ext} size={48} />
        <div className="min-w-0">
          <h2 className="m-0 text-v2-title font-[650]">{ext.displayName}</h2>
          <div className="mt-0.5 text-v2-body text-[var(--v2-muted)]">{ext.namespace}{ext.verified ? " (verified)" : ""} · Open VSX{detail?.license ? ` · ${detail.license}` : ""}</div>
          <p className="mt-1.5 text-v2-base text-[var(--v2-text-2)]">{ext.description}</p>
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabledReason={INSTALL_REASON}>Install for this project</Button>
        <Button disabledReason={INSTALL_REASON} aria-label="Install scope">Scope</Button>
        <Button variant="quiet" disabledReason={PIN_REASON}>Pin a version</Button>
      </div>
      <p className="m-0 text-v2-body text-[var(--v2-muted)]">{INSTALL_REASON}.</p>
      <Section title="Seats get it too" sub="Pick which seats receive it once installs open">
        {peers.length === 0 ? <div className="text-v2-body text-[var(--v2-muted)]">No seats are connected.</div> : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {peers.map(p => (
              <li key={p.session}>
                <label title={SEAT_REASON} className="flex items-center gap-2 text-v2-base text-[var(--v2-muted)]">
                  <Checkbox disabled aria-label={`Give ${p.session} this extension`} />
                  <span className="text-[var(--v2-text-2)]">{p.session}</span>
                  {p.machine && <span className="text-v2-small">{p.machine}</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Facts ext={ext} detail={detail} error={error} />
      {readme && (
        <Section title="README">
          <pre className="m-0 whitespace-pre-wrap break-words font-[inherit] text-v2-body leading-relaxed text-[var(--v2-text-2)]">{readme}</pre>
        </Section>
      )}
    </section>
  );
}

function Facts({ ext, detail, error }: { ext: Ext; detail: ExtDetail | null; error: string | null }) {
  const rows: [string, string][] = [
    ["Installs", formatCount(ext.downloads)],
    ["Rating", ext.rating === null ? "no rating" : `${ext.rating.toFixed(1)} stars${detail?.reviewCount != null ? ` · ${detail.reviewCount} reviews` : ""}`],
    ["Version", ext.version],
  ];
  if (detail?.timestamp) rows.push(["Updated", new Date(detail.timestamp).toLocaleDateString("en-US")]);
  if (detail?.license) rows.push(["License", detail.license]);
  if (detail?.repository) rows.push(["Source", detail.repository]);
  return (
    <Section title="Facts" actions={error ? <Chip tone="warn">details unavailable</Chip> : undefined}>
      <dl className="m-0 grid grid-cols-[96px_1fr] gap-y-1.5 text-v2-body">
        {rows.map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-[var(--v2-muted)]">{k}</dt><dd className="m-0 break-words text-[var(--v2-text-2)]">{v}</dd></div>
        ))}
      </dl>
    </Section>
  );
}
