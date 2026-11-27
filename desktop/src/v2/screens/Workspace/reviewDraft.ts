import { createContext } from "react";

export type ReviewDraft = { project: string; text: string };
export const ReviewDraftContext = createContext<ReviewDraft | null>(null);

const applied = new WeakSet<ReviewDraft>();
export function takeReviewDraft(draft: ReviewDraft | null): string | null {
  if (!draft || applied.has(draft)) return null;
  applied.add(draft);
  return draft.text;
}
