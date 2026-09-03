// wakeKickoff.ts — the project-row WAKE decision (#6120).
//
// A wake used to be one canned recap prompt (PLAIN_WAKE_KICKOFF). Under the two-paths doctrine a
// project whose repo carries docs/PRD.md and whose board has no build cards yet is a project
// whose review never convened: waking it with "recap and wait" would strand the brief. This
// module is only the pure decision + the open-card predicate, so the app stays thin and the
// rule is directly unit-testable. Any probe failure falls toward the plain wake in the caller —
// a missing PRD answer must never block a wake.
import type { Card } from "../../shared/api/client";
import { PLAIN_WAKE_KICKOFF } from "./genesis";

/** The review kickoff for a WAKE (no brief text in hand — the file is already in the repo).
 *  Wording per #6112 (codex's flow work); the DECISION of when to use it lives here (#6120). */
export const REVIEW_WAKE_KICKOFF =
  "Your brief is in docs/PRD.md. Read it and convene the PRD review: open one review card, dispatch the rubric to the live seats, and wait for the crew consensus before any build card.";

/** A build card is OPEN implementation work: todo, doing, or testing. The PRD-review card itself
 *  (and the review/TDD bookkeeping it spawns) is NOT build work — if it counted, a project whose
 *  review already convened would look un-reviewed and every wake would re-convene it. #6112
 *  names the card "a PRD-review card"; that title is the marker until the flow grows a real one. */
export function isReviewCard(card: Pick<Card, "title">): boolean {
  return /prd[\s-]?review/i.test(card.title);
}

export function hasBuildCards(cards: Pick<Card, "title" | "status">[]): boolean {
  return cards.some(card => ["todo", "doing", "testing"].includes(card.status) && !isReviewCard(card));
}

export function wakeKickoffFor(input: { prd: boolean; buildCards: boolean }): string {
  return input.prd && !input.buildCards ? REVIEW_WAKE_KICKOFF : PLAIN_WAKE_KICKOFF;
}
