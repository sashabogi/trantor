// Which file the Code lens opened FROM the graph (#11603), so it can offer the way back.
export type GraphOrigin = { project: string; path: string };

/** Cmd+[ (browser-style back). */
export function isGraphBackKey(e: { metaKey: boolean; ctrlKey: boolean; key: string }): boolean {
  return (e.metaKey || e.ctrlKey) && e.key === "[";
}
