// Which seats of a project live on ANOTHER machine (#13938): a seat is remote when its /peers
// machine label is set and differs from THIS machine's machine-id. One shared resolution for
// the ModePane's picker and the Files center, so the two can never disagree about whose
// worktree is local.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { HubClient, Peer } from "../../shared/api/client";
import { errorLine, isUnreachable, machineSsh, remoteSeatSnapshot, type RemoteSeatSnapshot } from "./remoteSeatApi";

/** seat name → machine label, for this project's seats whose machine differs from ours. The
 *  orchestrator's MacBook-Pro session is filtered the same way scopeSeats does — it is not a
 *  seat with a worktree, it is the human's session. */
export function remoteSeatMachines(
  peers: Peer[],
  project: string,
  ownMachine: string | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!ownMachine) return out;
  for (const p of peers) {
    if (!p.session.endsWith(`:${project}`)) continue;
    const seat = p.session.split(":")[0];
    if (seat.toLowerCase().startsWith("macbook")) continue;
    const machine = p.machine?.trim();
    if (machine && machine !== ownMachine) out.set(seat, machine);
  }
  return out;
}

let ownMachineCache: string | undefined;

/** This machine's label (~/.agent-bus/machine-id via the machine_id command), cached per run. */
export function useOwnMachineId(): string | undefined {
  const [own, setOwn] = useState<string | undefined>(ownMachineCache);
  useEffect(() => {
    if (ownMachineCache !== undefined) return;
    let alive = true;
    invoke<string>("machine_id")
      .then(id => { ownMachineCache = id.trim() || undefined; if (alive) setOwn(ownMachineCache); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return own;
}

/** machine label → ssh target (null = none configured). One probe per label; stable while the
 *  label SET is stable, so a picker refresh costs no new lookups. */
export function useMachineSshTargets(labels: string[]): Map<string, string | null> {
  const key = labels.join(",");
  const [targets, setTargets] = useState<Map<string, string | null>>(new Map());
  useEffect(() => {
    let alive = true;
    const list = key === "" ? [] : key.split(",");
    void Promise.all(list.map(async l => [l, await machineSsh(l).catch(() => null)] as const))
      .then(pairs => { if (alive) setTargets(new Map(pairs)); });
    return () => { alive = false; };
  }, [key]);
  return targets;
}

/** The poll state of one remote seat. "unreachable" is its own kind on purpose: the drill
 *  demands ssh-down reads as unreachable, never as clean. */
export type RemoteSeatState =
  | { kind: "loading" }
  | { kind: "ok"; snap: RemoteSeatSnapshot }
  | { kind: "unreachable"; reason: string }
  | { kind: "error"; reason: string };

/** Poll every CONFIGURED remote seat's snapshot, one ssh connection per seat per tick — the
 *  same 12s cadence the pane's other polls use. Unset on unmount; a seat that loses its config
 *  simply stops being polled and falls back to the "no ssh target" state. */
export function useRemoteSeatSnapshots(
  project: string,
  seats: { seat: string; machine: string }[],
): Map<string, RemoteSeatState> {
  const key = seats.map(s => `${s.seat}@${s.machine}`).sort().join(",");
  const [states, setStates] = useState<Map<string, RemoteSeatState>>(new Map());
  useEffect(() => {
    if (key === "") { setStates(new Map()); return; }
    let alive = true;
    const list = key.split(",").map(pair => {
      const [seat, machine] = pair.split("@");
      return { seat, machine };
    });
    const pull = () => {
      for (const { seat, machine } of list) {
        remoteSeatSnapshot(project, seat, machine)
          .then(snap => { if (alive) setStates(prev => new Map(prev).set(seat, { kind: "ok", snap })); })
          .catch(err => {
            if (!alive) return;
            const message = err instanceof Error ? err.message : String(err);
            const reason = errorLine(message);
            const state: RemoteSeatState = isUnreachable(message)
              ? { kind: "unreachable", reason }
              : { kind: "error", reason };
            setStates(prev => new Map(prev).set(seat, state));
          });
      }
    };
    pull();
    const iv = setInterval(pull, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [project, key]);
  return states;
}

/** Files.tsx's own light peers poll: the selected seat's machine label, refreshed at the same
 *  12s cadence everything else trusts. */
export function useSeatMachine(client: HubClient, project: string, seat: string | null): string | undefined {
  const [machine, setMachine] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!seat) { setMachine(undefined); return; }
    let alive = true;
    const load = () => {
      client.peers()
        .then(peers => {
          if (!alive) return;
          const hit = peers.find(p => p.session.split(":")[0] === seat && p.session.endsWith(`:${project}`));
          setMachine(hit?.machine?.trim() || undefined);
        })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [client, project, seat]);
  return machine;
}
