// Attachments render as CHIPS (#6070), never as a path inside the text area, because dictation
// can splice a word into the middle of a path and break it (#5773). Chips serialize at send
// time into the same wire text the delivery contract already expects (#5507, #5709): one
// attach mechanism, three doors (drop, paste, picker). Pure module: add/remove/serialize.

export type AttachmentKind = "image" | "file";

export type AttachmentChip = {
  /** Stable key for React + removal. Never derived from the path alone — a double-drop would fuse
   *  two removals into one. */
  id: string;
  /** The absolute path — the unit of delivery, serialized verbatim into the send. */
  path: string;
  /** Images may carry a thumbnail; everything else renders name + size. */
  kind: AttachmentKind;
  /** The basename, for the chip's face — paths with spaces are normal here (CleanShot). */
  name: string;
  /** Bytes once the disk answered; null until then. A chip never waits for its size. */
  size: number | null;
};

// The extensions the delivery contract counts as attachments (streaming.ts IMAGE_PATH_RE without
// pdf — a pdf cannot thumbnail, so it wears the file face). What a chip SHOWS and what the send
// NORMALIZES are separate questions that agree on what an image is. Case-insensitive: a dropped
// "SHOT.PNG" is still an image.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic)$/i;

export function chipKind(path: string): AttachmentKind {
  return IMAGE_EXT_RE.test(path) ? "image" : "file";
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function makeChip(id: string, path: string, size: number | null): AttachmentChip {
  return { id, path, kind: chipKind(path), name: baseName(path), size };
}

/** Append chips, DEDUPING by path: a double-drop of the same file is one chip, and picking a file
 *  that is already attached is a no-op. Order is arrival order; nothing is ever reordered. */
export function addChips(chips: readonly AttachmentChip[], add: readonly AttachmentChip[]): AttachmentChip[] {
  const out = [...chips];
  for (const a of add) {
    if (!out.some(c => c.path === a.path)) out.push(a);
  }
  return out;
}

export function removeChip(chips: readonly AttachmentChip[], id: string): AttachmentChip[] {
  return chips.filter(c => c.id !== id);
}

/** Serialize chips into the send text, matching the shapes #5507/#5709 already produce:
 *  one chip stays inline ("path draft"); two or more go one path per line before the prose,
 *  without "(image N)" markers. No chips: the draft passes through untouched. */
export function serializeForSend(chips: readonly AttachmentChip[], draft: string): string {
  const text = draft.trim();
  if (!chips.length) return draft;
  const first = chips[0];
  if (chips.length === 1 && first) {
    return text ? `${first.path} ${text}` : first.path;
  }
  const paths = chips.map(c => c.path).join("\n");
  return text ? `${paths}\n${text}` : paths;
}

/** A human file size for the chip's face: "812B", "96.0KB", "1.4MB". One decimal below 10 of a
 *  unit — enough to tell a favicon from a screenshot without a byte count's noise. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)}B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))}KB`;
  }
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))}MB`;
}
