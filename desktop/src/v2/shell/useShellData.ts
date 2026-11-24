// The shell's data, built exactly the way classic AppShell builds it: known projects, the active
// project's hub, the signed identity, and the same peek-only inbox count (#v2-F).
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HubClient, hubForProject, knownProjects, localSessions, type Peer } from "../../shared/api/client";
import { countUnseen, onSeenChange } from "../../shared/seen";
import { usePendingHolds } from "../../shared/FileHolds";
import { usePendingProposals } from "../../shared/Proposals";

export const LOCAL_HUB = "http://127.0.0.1:4477";
const PROJECT_KEY = "trantor.v2.project";

function savedProject(): string {
  try { return localStorage.getItem(PROJECT_KEY) ?? ""; } catch { return ""; }
}

function useProjects() {
  const [projects, setProjects] = useState<string[]>([]);
  const [active, setActive] = useState<string>(savedProject);
  useEffect(() => {
    let alive = true;
    const pull = () => knownProjects().catch((): string[] => []).then(found => {
      if (!alive) return;
      const all = [...new Set(found)].sort();
      setProjects(prev => (all.length === prev.length && all.every((v, i) => v === prev[i]) ? prev : all));
      setActive(a => (a && all.includes(a) ? a : all[0] || ""));
    });
    void pull();
    const t = setInterval(pull, 45_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => { try { if (active) localStorage.setItem(PROJECT_KEY, active); } catch { /* storage blocked */ } }, [active]);
  return { projects, active, setActive };
}

function useIdentity(hub: string) {
  const [me, setMe] = useState("");
  useEffect(() => {
    let alive = true;
    void invoke<string>("identity_name", { base: hub || undefined }).then(name => { if (alive) setMe(name); }).catch(() => {});
    return () => { alive = false; };
  }, [hub]);
  return me;
}

/** Direct messages to the human that are not marked seen; peeking never moves the hub cursor. */
function useUnread(client: HubClient, me: string) {
  const [unread, setUnread] = useState(0);
  const ids = useRef<number[]>([]);
  useEffect(() => {
    if (!me) return;
    let alive = true;
    const pull = () => client.inbox(me).then(r => {
      if (!alive) return;
      ids.current = (r.messages ?? []).filter(m => m.to === me).map(m => m.id);
      setUnread(countUnseen(ids.current));
    }).catch(() => {});
    void pull();
    const t = setInterval(pull, 30_000);
    const off = client.streamEvents(ev => { if (ev.type === "message") void pull(); });
    const offSeen = onSeenChange(() => { if (alive) setUnread(countUnseen(ids.current)); });
    return () => { alive = false; clearInterval(t); off(); offSeen(); };
  }, [client, me]);
  return unread;
}

/** Projects with an open local session or an online peer: the rail's "active now" tiles. */
function useLiveProjects(client: HubClient) {
  const [live, setLive] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      const urls = [...new Set([client.baseUrl, LOCAL_HUB])];
      const [open, ...lists] = await Promise.all([
        localSessions().catch(() => []),
        ...urls.map(u => new HubClient(u).peers().catch((): Peer[] => [])),
      ]);
      if (!alive) return;
      const names = new Set<string>();
      for (const s of open) if (s.status) names.add(s.project);
      for (const p of lists.flat()) if (p.online && p.project) names.add(p.project);
      setLive([...names].sort());
    };
    void pull();
    const t = setInterval(() => void pull(), 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);
  return live;
}

export function useShellData() {
  const { projects, active, setActive } = useProjects();
  const [hub, setHub] = useState("");
  useEffect(() => { if (active) void hubForProject(active).then(setHub).catch(() => setHub("")); }, [active]);
  const me = useIdentity(hub);
  // With no pinned hub yet the local hub still answers, so screens always get a client.
  const client = useMemo(() => new HubClient(hub || LOCAL_HUB), [hub]);
  const unread = useUnread(client, me);
  const needsYou = usePendingProposals(client).length + usePendingHolds(client).length;
  const live = useLiveProjects(client);
  return { projects, active, setActive, hub, me, client, unread, needsYou, live };
}
