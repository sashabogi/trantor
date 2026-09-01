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
 * Decide between silently reloading the open file and warning the operator.
 *
 * - no fresh stat, or no baseline yet: nothing to act on (the first poll only sets the baseline)
 * - stat unchanged: nothing to do
 * - stat changed and the editor holds unsaved work: conflict, never clobber the operator's edits
 * - stat changed and the editor is clean: reload silently
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
