// The composer's draft (#11665): the words, the attachment chips and the project they were written
// for, kept per project. One composer is mounted for whichever project is selected, so a bare
// useState let a draft written for project A ride into project B and Enter sent it to B's agent.
// A draft now carries its project, lives in a slot keyed by it, and a send refuses a mismatch.
//
// Durability follows the lensState.ts convention (#11597): ~/.agent-bus/config.json under
// "composerDrafts", one row per project (composer_draft.rs). Chips are file PATHS — a pasted image
// is already a real file under ~/.agent-bus/attachments — so they survive a restart with the text.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { makeChip, type AttachmentChip } from "./attachments";

type InvokeFn = <T>(cmd: string, args?: InvokeArgs) => Promise<T>;

export type ComposerDraft = { project: string; text: string; chips: AttachmentChip[] };

export const emptyDraft = (project: string): ComposerDraft => ({ project, text: "", chips: [] });

export const isEmptyDraft = (d: ComposerDraft): boolean => !d.text && d.chips.length === 0;

/** A draft may only be sent to the project it was written in. The composer's `project` prop moves
 *  with the selection; the draft's own project does not, so a draft left behind by a switch that
 *  has not been swapped out yet can never reach the new project's agent. */
export const canSendDraft = (d: ComposerDraft, project: string): boolean => d.project === project;

// Chip ids are module-wide, not per composer instance: a remount (lens switch) must not restart
// the count and collide with the ids of chips restored from a slot.
let chipSeq = 0;
export const nextChipId = (): string => `chip-${chipSeq += 1}`;

// The in-memory slots survive project switches and lens switches (the composer unmounts and
// remounts); the disk copy below survives a restart. A slot exists once a draft was ever edited
// for the project, an emptied one included, so a cleared draft is not resurrected from disk.
const slots = new Map<string, ComposerDraft>();

export const draftSlots = {
  get: (project: string): ComposerDraft | undefined => slots.get(project),
  put: (draft: ComposerDraft): void => { slots.set(draft.project, draft); },
  /** Test seam: forget every slot, the way a fresh app launch starts. */
  reset: (): void => { slots.clear(); pending.forEach(p => clearTimeout(p.timer)); pending.clear(); },
};

/** The persisted shape of a draft: the project is the row key, a chip is its path and size. */
type StoredDraft = { text: string; chips: { path: string; size: number | null }[] };

export function toStored(d: ComposerDraft): StoredDraft | null {
  if (isEmptyDraft(d)) return null;
  return { text: d.text, chips: d.chips.map(c => ({ path: c.path, size: c.size })) };
}

/** A stored row back into a draft for `project`, or null when it is not a draft we wrote. */
export function fromStored(project: string, raw: unknown): ComposerDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { text?: unknown; chips?: unknown };
  const text = typeof row.text === "string" ? row.text : "";
  const chips: AttachmentChip[] = [];
  if (Array.isArray(row.chips)) {
    for (const c of row.chips as { path?: unknown; size?: unknown }[]) {
      if (!c || typeof c.path !== "string" || !c.path) continue;
      chips.push(makeChip(nextChipId(), c.path, typeof c.size === "number" ? c.size : null));
    }
  }
  const draft: ComposerDraft = { project, text, chips };
  return isEmptyDraft(draft) ? null : draft;
}

export const composerDraftApi = {
  get: async (project: string, invokeFn: InvokeFn = invoke): Promise<ComposerDraft | null> => {
    try {
      return fromStored(project, JSON.parse(await invokeFn<string>("composer_draft_get", { project })));
    } catch { return null; }
  },
  set: async (draft: ComposerDraft, invokeFn: InvokeFn = invoke): Promise<void> => {
    try {
      await invokeFn("composer_draft_set", { project: draft.project, draft: JSON.stringify(toStored(draft)) });
    } catch { /* a refusing store keeps the draft in memory for this session only */ }
  },
};

// Writes are debounced per project: a keystroke must not cost a config.json rewrite. Leaving the
// composer (unmount) flushes what is pending so a quick quit does not lose the last words.
const SAVE_DELAY_MS = 400;
const pending = new Map<string, { draft: ComposerDraft; timer: ReturnType<typeof setTimeout> }>();

export function scheduleSave(draft: ComposerDraft, invokeFn: InvokeFn = invoke, delayMs = SAVE_DELAY_MS): void {
  const prior = pending.get(draft.project);
  if (prior) clearTimeout(prior.timer);
  const timer = setTimeout(() => {
    pending.delete(draft.project);
    void composerDraftApi.set(draft, invokeFn);
  }, delayMs);
  pending.set(draft.project, { draft, timer });
}

export function flushSaves(invokeFn: InvokeFn = invoke): void {
  for (const { draft, timer } of [...pending.values()]) {
    clearTimeout(timer);
    void composerDraftApi.set(draft, invokeFn);
  }
  pending.clear();
}
