// The per-tab disk-change guard (#5811), the persistent version of the conflict bar. Orca keeps
// `lastKnownDiskSignature` + `externalMutation` ON THE TAB (open-file.ts:124-128): a file that
// moved on disk while a tab held unsaved work stays flagged until the operator resolves it, and
// the flag survives tab switches instead of living in one component's local state. These are the
// two pure decisions the Files lens needs for that; the component owns the maps.

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

/** Decided when a tab's file is re-read while the tab holds a draft.
 *
 *  - No draft: nothing to protect — the disk text simply becomes the editor's content.
 *  - Draft already IS the disk text: a clean tab, likewise nothing.
 *  - The disk text equals what the draft was based on (same signature): the disk did not move.
 *  - Otherwise the disk MOVED AWAY from under the draft: "moved", and the caller must flag the
 *    tab, keep the draft, and gate saving until the operator picks reload or keep. */
export function externalMutationOnLoad(args: {
  draft: string | null;
  baseSignature: string | null;
  diskText: string;
}): DiskVerdict {
  if (args.draft === null) return null;
  if (args.draft === args.diskText) return null;
  if (args.baseSignature !== null && diskSignature(args.diskText) === args.baseSignature) {
    return null;
  }
  return "moved";
}
