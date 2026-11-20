import type { Peer } from "./api/client";

export function machineOf(peer: Pick<Peer, "machine">): string | undefined {
  return peer.machine?.trim() || undefined;
}

export function machineBadgesVisible(peers: Pick<Peer, "machine">[]): boolean {
  const machines = new Set(peers.map(machineOf).filter((machine): machine is string => !!machine));
  return machines.size > 0 && !(machines.size === 1 && peers.every(peer => !!machineOf(peer)));
}

export function MachineBadge({ machine }: { machine?: string }) {
  const label = machine?.trim();
  if (!label) return null;
  return (
    <span
      className="tr-mono shrink-0 rounded-[5px] border border-tr-edge px-1.5 py-0.5 text-[9.5px] font-normal leading-none text-tr-muted"
      title={`Runs on ${label}`}
    >
      {label}
    </span>
  );
}
