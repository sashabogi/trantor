// The open file follows the disk. Polling a file's stat (modified time + size) is how the viewer
// learns a seat just wrote the file it is showing, without re-reading the whole body every tick.
// The decision is a pure function so the reload-vs-conflict rule is testable, not buried in the
// component's effect where it cannot be pinned down.

export type FileStat = {
  /** modified time in milliseconds since the Unix epoch, 0 when the OS could not say */
  mtimeMs: number;
  /** file size in bytes — a cheap second signal that this file changed */
  bytes: number;
};

/** What to do when a file's stat moved under the operator. */
export type ReloadDecision = "reload" | "conflict" | "none";

/**
 * Silently reload the open file or warn: no baseline or unchanged stat means nothing to do; a
 * changed stat with unsaved work is a conflict (never clobber); changed and clean reloads silently.
 */
export function decideReload(args: {
  /** whether the editor holds unsaved work a reload would clobber */
  dirty: boolean;
  /** the last stat we acted on, or null before the first poll */
  lastStat: FileStat | null;
  /** the stat just read from disk, or null when the file could not be stat'd */
  newStat: FileStat | null;
}): ReloadDecision {
  const { dirty, lastStat, newStat } = args;
  if (!newStat || !lastStat) return "none";
  const unchanged = lastStat.mtimeMs === newStat.mtimeMs && lastStat.bytes === newStat.bytes;
  if (unchanged) return "none";
  return dirty ? "conflict" : "reload";
}
