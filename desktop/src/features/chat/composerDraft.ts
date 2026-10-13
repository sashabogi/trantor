// The composer's draft (#11665): words, attachment chips and the project they were written for,
// in a slot per project, so a draft can never ride into another project and a send refuses it.
// Durable like lensState.ts (#11597): config.json "composerDrafts", one row per project; chips are paths.
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

/** What a parsed config.json row can hold; fromStored narrows it field by field. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
const isJsonObject = (v: JsonValue | undefined): v is JsonObject => v instanceof Object && !Array.isArray(v);
const isJsonString = (v: JsonValue | undefined): v is string => String(v) === v;
const isJsonNumber = (v: JsonValue | undefined): v is number => Number.isFinite(v);

/** A stored row back into a draft for `project`, or null when it is not a draft we wrote. */
export function fromStored(project: string, raw: JsonValue): ComposerDraft | null {
  if (!isJsonObject(raw)) return null;
  const text = isJsonString(raw.text) ? raw.text : "";
  const chips: AttachmentChip[] = [];
  if (Array.isArray(raw.chips)) {
    for (const c of raw.chips) {
      if (!isJsonObject(c) || !isJsonString(c.path) || !c.path) continue;
      chips.push(makeChip(nextChipId(), c.path, isJsonNumber(c.size) ? c.size : null));
    }
  }
  const draft: ComposerDraft = { project, text, chips };
  return isEmptyDraft(draft) ? null : draft;
}

export const composerDraftApi = {
  get: async (project: string, invokeFn: InvokeFn = invoke): Promise<ComposerDraft | null> => {
    try {
      // SAFETY: JSON.parse yields a JsonValue by construction; fromStored checks every field it reads.
      return fromStored(project, JSON.parse(await invokeFn<string>("composer_draft_get", { project })) as JsonValue);
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
