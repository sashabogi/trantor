// UI lookup tables keyed by a CLOSED set are indexed at call sites by strings that arrive from the
// hub and are not closed at the type level. The table keeps its literal-keyed type (`as const
// satisfies Record<...>`), so indexing needs a lookup that tolerates a miss instead of a cast.
export function dictGet<V>(map: Record<string, V>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}
