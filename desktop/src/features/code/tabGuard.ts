// The per-tab disk-change guard (#5811), the persistent version of the conflict bar. Orca keeps
// `lastKnownDiskSignature` + `externalMutation` ON THE TAB (open-file.ts:124-128) so the flag
// survives tab switches instead of living in one component's local state. These are the two pure
// decisions the Files lens needs; the component owns the maps.

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

/** Decided when a tab's file is re-read while the tab holds a draft: no draft, or draft already
 *  matching disk, or disk still matching the draft's base signature all mean nothing to do.
 *  Otherwise the disk moved away from under the draft ("moved"), and the caller must flag the tab,
 *  keep the draft, and gate saving until the operator picks reload or keep. */
export function externalMutationOnLoad(args: {
  draft: string | null;
  baseSignature: string | null;
  diskText: string;
}): DiskVerdict {
  if (args.draft === null) return null;
  // A draft with NO recorded base signature cannot be evidence of anything: it predates the
  // first completed load: a tab switch can stash the still-empty
  // draft before readFile resolved, and this function then called the file "moved", showing an
  // empty editor under a false conflict bar). No base, no verdict — the disk text wins.
  if (args.baseSignature === null) return null;
  if (args.draft === args.diskText) return null;
  if (diskSignature(args.diskText) === args.baseSignature) {
    return null;
  }
  return "moved";
}
