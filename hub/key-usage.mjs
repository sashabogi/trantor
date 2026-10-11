// Include retained peers and instance subkeys, without roster TTL or project filtering.
export function keyUsageSnapshot(state, now, onlineMs) {
  const rows = new Map();
  const add = (pubkey, lastSeen = 0, live = false) => {
    if (!pubkey) return;
    const previous = rows.get(pubkey);
    rows.set(pubkey, { pubkey, lastSeen: Math.max(previous?.lastSeen || 0, lastSeen), live: !!previous?.live || live });
  };
  for (const [pubkey, id] of Object.entries(state.identities || {})) add(pubkey, id.lastSeen || 0);
  for (const peer of Object.values(state.peers || {})) {
    add(peer.pubkey || peer.identity?.pubkey, peer.lastSeen || 0, (peer.lastSeen || 0) > now - onlineMs);
  }
  for (const instance of Object.values(state.instances || {})) add(instance.durable, instance.lastSeen || 0);
  return { complete: true, identities: [...rows.values()] };
}
