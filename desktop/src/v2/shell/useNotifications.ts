// Hub events that need a human raise a system notification in the 2.0 shell too. The classic
// shell does this in AppShell, which 2.0 never mounts, so the Notifications switch did nothing
// here until this hook (#14108 drill). Mounted once by the shell, so nothing notifies twice.
import { useEffect, useRef } from "react";
import type { HubClient } from "../../shared/api/client";
import { notifyIfWorthIt } from "../../shared/notify";

const OFFLINE_AFTER_MS = 5 * 60 * 1000;
const PEERS_EVERY_MS = 60_000;

export function useNotifications(client: Pick<HubClient, "peers" | "streamEvents">, me: string): void {
  // When each session was last seen: a message to one that has gone quiet becomes the human's notification.
  const lastSeen = useRef(new Map<string, number>());
  useEffect(() => {
    if (!me) return;
    let alive = true;
    const pull = () => client.peers().then(peers => {
      if (!alive) return;
      const seen = new Map<string, number>();
      for (const p of peers) seen.set(p.session, p.online ? Date.now() : (p.lastSeen ?? 0));
      lastSeen.current = seen;
    }).catch(() => {});
    void pull();
    const timer = setInterval(() => void pull(), PEERS_EVERY_MS);
    const isOffline = (session: string) => {
      const seen = lastSeen.current.get(session);
      return seen === undefined || Date.now() - seen > OFFLINE_AFTER_MS;
    };
    const off = client.streamEvents(ev => { void notifyIfWorthIt(ev, me, isOffline); });
    return () => { alive = false; clearInterval(timer); off(); };
  }, [client, me]);
}
