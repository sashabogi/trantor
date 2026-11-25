import type { AskQuestion } from "./streaming";

export type QuestionPick = { picks: number[]; other: string };
export type AskPicks = { index: number; answers: QuestionPick[] };
export type AskAnswerOut = { picks: number[]; other: string | null };

export function startPicks(questions: AskQuestion[]): AskPicks {
  return { index: 0, answers: questions.map(() => ({ picks: [], other: "" })) };
}

export function moveTo(state: AskPicks, index: number): AskPicks {
  const last = state.answers.length - 1;
  return { ...state, index: Math.max(0, Math.min(last, index)) };
}

function setAt(state: AskPicks, answer: QuestionPick): AskPicks {
  return { ...state, answers: state.answers.map((a, i) => (i === state.index ? answer : a)) };
}

/** A single choice holds one answer: a pick or typed text, the latest one wins. */
export function choose(state: AskPicks, question: AskQuestion, option: number): AskPicks {
  const now = state.answers[state.index];
  if (!now) return state;
  if (!question.multiSelect) return setAt(state, { picks: [option], other: "" });
  const has = now.picks.includes(option);
  const picks = has ? now.picks.filter(p => p !== option) : [...now.picks, option];
  return setAt(state, { picks, other: now.other });
}

export function typeOther(state: AskPicks, question: AskQuestion, text: string): AskPicks {
  const now = state.answers[state.index];
  if (!now) return state;
  return setAt(state, { picks: question.multiSelect ? now.picks : [], other: text });
}

export function isAnswered(answer: QuestionPick | undefined): boolean {
  return !!answer && (answer.picks.length > 0 || answer.other.trim() !== "");
}

export function isComplete(state: AskPicks): boolean {
  return state.answers.length > 0 && state.answers.every(isAnswered);
}

export function toAnswers(state: AskPicks): AskAnswerOut[] {
  return state.answers.map(a => ({
    picks: [...a.picks].sort((x, y) => x - y),
    other: a.other.trim() === "" ? null : a.other,
  }));
}
