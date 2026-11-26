// What the operator sent (#14327): a right-aligned bubble. The data-prompt-* attributes are what the
// prompt timeline reads off the page, so they stay exactly as the classic chat set them.
import { useLayoutEffect, useRef, useState } from "react";

export type PromptData = { id: string; ts?: number; reply?: string; workedMs?: number; files?: string[] };

/** Past this many lines a message is clipped behind "Show all". */
export const CLAMP_LINES = 8;

export function UserMessage({ text, queued, prompt }: { text: string; queued?: boolean; prompt: PromptData }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(() => text.split("\n").length > CLAMP_LINES);
  // Measured when the page has a layout; by line count where it has none.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    setClipped(el.clientHeight > 0 ? el.scrollHeight > el.clientHeight + 1 : text.split("\n").length > CLAMP_LINES);
  }, [text, expanded]);
  return (
    <div className="mt-3 flex flex-col items-end gap-1">
      <div className="max-w-[min(520px,85%)] rounded-xl rounded-br-sm border border-[var(--v2-edge-2)] bg-[var(--v2-raised)] px-3 py-2 text-v2-base leading-[1.55]">
        <div ref={ref} data-prompt-id={prompt.id} data-prompt-ts={prompt.ts} data-prompt-reply={prompt.reply}
          data-prompt-worked-ms={prompt.workedMs} data-prompt-files={prompt.files?.length ? JSON.stringify(prompt.files) : undefined}
          className="whitespace-pre-wrap [overflow-wrap:anywhere]"
          style={expanded ? undefined : { display: "-webkit-box", WebkitLineClamp: CLAMP_LINES, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {text}
        </div>
        {(clipped || expanded) && (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}
            className="mt-1 text-v2-small text-[var(--v2-muted)] hover:text-[var(--v2-text)]">
            {expanded ? "Show less" : "Show all"}
          </button>
        )}
      </div>
      {queued && (
        <span title="Delivered to the session's queue; it has not read this yet and will on its next turn boundary"
          className="rounded-sm bg-[var(--v2-warn-soft)] px-1.5 py-px text-v2-small text-[var(--v2-warn)]">
          queued
        </span>
      )}
    </div>
  );
}
