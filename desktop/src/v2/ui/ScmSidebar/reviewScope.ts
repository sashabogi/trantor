import { useSyncExternalStore } from "react";

export type ReviewScope = { name: string; back: () => void };
const scopes = new Map<string, ReviewScope>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The mounted source-control column owns this transient header signal. */
export function publishReview(project: string, review: ReviewScope | null) {
  if (review) scopes.set(project, review); else scopes.delete(project);
  listeners.forEach(listener => listener());
  return () => {
    if (scopes.get(project) === review) {
      scopes.delete(project);
      listeners.forEach(listener => listener());
    }
  };
}

export function useReviewScope(project: string) {
  return useSyncExternalStore(subscribe, () => scopes.get(project) ?? null);
}

export type ReviewMessage = { scope: string; name: string; files: number };
const messages = new Map<string, ReviewMessage>();
export function queueReviewMessage(project: string, message: ReviewMessage) { messages.set(project, message); }
export function peekReviewMessage(project: string) { return messages.get(project); }
export function takeReviewMessage(project: string) {
  const message = messages.get(project);
  messages.delete(project);
  return message;
}
