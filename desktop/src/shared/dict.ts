// A handful of UI lookup tables (lane/status colors, flow transitions, sidebar ordering) are keyed
// by a CLOSED set of values, but the strings used to index them at the call site — a card's
// `status`, a hub event's `kind` — arrive from the hub and are not closed at the type level. Once
// the table itself keeps its literal-keyed inferred type (`as const satisfies Record<...>`, so it
// still reads as real evidence rather than a widened-open dictionary), indexing it with one of
// those unclosed strings needs a lookup that tolerates a miss instead of a cast.
export function dictGet<V>(map: Record<string, V>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}
