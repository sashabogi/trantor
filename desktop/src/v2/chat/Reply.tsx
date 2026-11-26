// An assistant reply (#14327): no bubble and no label, just the markdown. The last text of a turn
// carries a small hover pill at its bottom-right with a copy button.
import { CopyButton } from "./bits";
import { Markdown } from "./Markdown";

export function ReplyActions({ text }: { text: string }) {
  return (
    <div data-testid="reply-actions"
      className="absolute -bottom-3 right-0 z-[2] flex gap-0.5 rounded-md border border-[var(--v2-edge-2)] bg-[var(--v2-raised)] p-0.5 opacity-0 shadow-[var(--v2-shadow-menu)] transition-opacity duration-[var(--v2-dur-1)] ease-[var(--v2-ease)] focus-within:opacity-100 group-hover:opacity-100">
      <CopyButton text={text} label="Copy reply" title="Copy reply" size={24} />
    </div>
  );
}

/** `copy` is the markdown the pill copies; omit it for narration between tool calls. */
export function AssistantText({ text, copy }: { text: string; copy?: string }) {
  return (
    <div className="group relative">
      <Markdown text={text} />
      {copy !== undefined && <ReplyActions text={copy} />}
    </div>
  );
}
