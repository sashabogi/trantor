import { useState } from "react";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { choose, isComplete, moveTo, startPicks, toAnswers, typeOther } from "./askPicks";
import type { AskQuestion } from "./streaming";

type Invoke = <T>(cmd: string, args?: InvokeArgs) => Promise<T>;

/** The card for an ask with several questions: one at a time, picks kept as you move, and one
 *  Submit that sends every answer in question order as a single keystroke run. */
export function MultiAskCard({ toolId, questions, enabled, waiting, invokeFn, onAnswer }: {
  toolId: string | null; questions: AskQuestion[]; enabled: boolean; waiting: boolean;
  invokeFn: Invoke; onAnswer: (toolId: string | null, data: string) => Promise<void>;
}) {
  const [state, setState] = useState(() => startPicks(questions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = questions[state.index];
  const now = state.answers[state.index];
  if (!q || !now) return null;
  const off = !enabled || busy;
  const last = state.index === questions.length - 1;

  const submit = async () => {
    if (off || !isComplete(state)) return;
    setBusy(true); setError(null);
    try {
      const data = await invokeFn<string>("answer_all_keystrokes", { questions, answers: toAnswers(state) });
      if (data) await onAnswer(toolId, data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="ask-card" className="mt-1.5 rounded-lg border border-tr-warn/40 bg-tr-warn/5 px-2.5 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[length:calc(11.5px*var(--chat-scale,1))] font-medium">
        <span className="tr-dot shrink-0" style={{ background: "var(--color-tr-warn)", width: 6, height: 6 }} />
        <span>{q.header || "Question"}</span>
        {q.multiSelect && <span className="shrink-0 text-[10.5px] font-normal text-tr-muted">pick any</span>}
        <span data-testid="ask-counter" className="ml-auto shrink-0 text-[10.5px] font-normal text-tr-muted">
          Question {state.index + 1} of {questions.length}
        </span>
      </div>
      <div className="mb-2 text-[length:calc(12px*var(--chat-scale,1))] leading-relaxed">{q.question}</div>
      <div className="flex flex-col gap-1">
        {q.options.map((opt, i) => (
          <button
            key={i}
            type="button"
            disabled={off}
            aria-pressed={now.picks.includes(i)}
            onClick={() => setState(s => choose(s, q, i))}
            className="flex items-start gap-1.5 rounded-lg border border-tr-edge bg-black/20 px-2.5 py-1.5 text-left disabled:opacity-50"
          >
            <span
              className="mt-0.5 h-3 w-3 shrink-0 rounded-[3px] border border-tr-edge"
              style={{ background: now.picks.includes(i) ? "var(--color-tr-warn)" : "transparent" }}
            />
            <span className="min-w-0 flex-1">
              <div className="text-[length:calc(11.5px*var(--chat-scale,1))] font-medium">{opt.label}</div>
              {opt.description && (
                <div className="text-[length:calc(11px*var(--chat-scale,1))] text-tr-muted">{opt.description}</div>
              )}
            </span>
          </button>
        ))}
      </div>
      <input
        type="text"
        value={now.other}
        onChange={e => setState(s => typeOther(s, q, e.target.value))}
        disabled={off}
        placeholder="Other: type an answer"
        className="mt-1.5 w-full rounded-[8px] border border-tr-edge bg-black/20 px-2 py-1 text-[11.5px] disabled:opacity-50"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={state.index === 0}
          onClick={() => setState(s => moveTo(s, s.index - 1))}
          className="rounded-[8px] bg-tr-panel px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="button"
          disabled={last}
          onClick={() => setState(s => moveTo(s, s.index + 1))}
          className="rounded-[8px] bg-tr-panel px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
        >
          Next
        </button>
        <button
          type="button"
          disabled={off || !isComplete(state)}
          onClick={() => { void submit(); }}
          className="ml-auto rounded-[8px] bg-tr-panel px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
        >
          Submit
        </button>
      </div>
      {waiting && <div className="mt-1.5 text-[10.5px] text-tr-muted">Waiting for the terminal question picker…</div>}
      {error && <div className="tr-mono mt-1.5 text-[10.5px] text-tr-fail">{error}</div>}
    </div>
  );
}
