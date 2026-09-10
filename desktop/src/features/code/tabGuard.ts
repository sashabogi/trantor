// The per-tab disk-change guard (#5811): Orca keeps `lastKnownDiskSignature` + `externalMutation` ON
// THE TAB, so a file that moved on disk under unsaved work stays flagged across tab switches.
// These are the two pure decisions; the component owns the maps.

/** A cheap, stable content fingerprint (FNV-1a 32-bit, hex). Not cryptographic — it exists so a
 *  guard can ask "is this the SAME text I based my edits on?" without holding whole files. */
export function diskSignature(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type DiskVerdict = "moved" | null;

/** Decided when a tab's file is re-read while the tab holds a draft: no draft or a clean tab means
 *  nothing; disk text equal to the draft's base signature means the disk did not move; otherwise
 *  "moved", and the caller flags the tab, keeps the draft, and gates saving. */
export function externalMutationOnLoad(args: {
  draft: string | null;
  baseSignature: string | null;
  diskText: string;
}): DiskVerdict {
  if (args.draft === null) return null;
  // A draft with NO recorded base signature predates the first completed load and cannot be evidence
  // of anything (a stash before readFile resolved once showed an empty editor under a false
  // conflict bar). No base, no verdict: the disk text wins.
  if (args.baseSignature === null) return null;
  if (args.draft === args.diskText) return null;
  if (diskSignature(args.diskText) === args.baseSignature) {
    return null;
  }
  return "moved";
}
