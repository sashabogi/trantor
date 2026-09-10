// UI lookup tables (lane/status colors, flow transitions, sidebar ordering) are keyed by a CLOSED
// set of values, but call-site strings (a card's `status`, a hub event's `kind`) arrive from the
// hub unclosed at the type level. Keep the table's literal-keyed inferred type (`as const
// satisfies Record<...>`) and index it with a lookup that tolerates a miss, never a cast.
export function dictGet<V>(map: Record<string, V>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}
