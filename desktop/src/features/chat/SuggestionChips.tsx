// The suggested-reply row (#5929), extracted so it can be rendered in a test: the proof that the
// chips are actually MOUNTED above the composer, not gated out of existence. Calm by contract —
// plain tr-chips, no new colors, a quiet "suggested" lead-in and an × that dismisses.
import type { Suggestion } from "./suggestions";

export function SuggestionChips({ suggestions, onPick, onDismiss }: {
  suggestions: Suggestion[];
  onPick: (text: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pb-1.5" data-testid="suggestion-chips">
      <span className="text-[10.5px] text-tr-muted/70">suggested</span>
      {suggestions.map(s => (
        <button
          key={s.text}
          type="button"
          title={s.tooltip}
          onClick={() => onPick(s.text)}
          className="tr-chip hover:text-tr-text"
        >
          {s.text}
        </button>
      ))}
      <button
        type="button"
        onClick={onDismiss}
        title="hide suggestions (Esc)"
        className="ml-1 text-[10.5px] text-tr-muted/70 hover:text-tr-muted"
      >
        ×
      </button>
    </div>
  );
}
