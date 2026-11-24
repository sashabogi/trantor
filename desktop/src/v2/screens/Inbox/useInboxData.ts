import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileHold, HubClient, Message, Peer, Proposal } from "../../../shared/api/client";

export function useInboxData(client: HubClient) {
  const [me, setMe] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [holds, setHolds] = useState<FileHold[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void invoke<string>("identity_name", { base: client.baseUrl })
      .then(name => { if (alive.current) setMe(name); })
      .catch(reason => {
        if (!alive.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoaded(true);
      });
    return () => { alive.current = false; };
  }, [client]);

  const reload = useCallback(async () => {
    if (!me) return;
    try {
      const [mail, peerList, permissionRequests, fileHolds] = await Promise.all([
        client.inbox(me),
        client.peers().catch((): Peer[] => []),
        client.proposals({ status: "pending" }).catch(() => ({ proposals: [], pendingCount: 0 })),
        client.holds().catch(() => ({ holds: [] })),
      ]);
      if (!alive.current) return;
      setMessages((mail.messages ?? []).filter(message => message.to === me));
      setPeers(peerList);
      setProposals(permissionRequests.proposals ?? []);
      setHolds(fileHolds.holds ?? []);
      setError("");
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [client, me]);

  useEffect(() => {
    if (!me) return;
    void reload();
    const timer = setInterval(() => void reload(), 30_000);
    const off = client.streamEvents(event => {
      if (event.type === "message" || event.type.startsWith("proposal.") || event.type.startsWith("hold.")) void reload();
    });
    return () => { clearInterval(timer); off(); };
  }, [client, me, reload]);

  return { me, messages, peers, proposals, holds, loaded, error, reload };
}
