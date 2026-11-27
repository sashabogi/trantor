// The find bar (artboard F3, #14516): sits under the address bar and pushes the page down. Enter
// steps forward, Shift+Enter back (browser_find); Esc closes (handled by the tab, which also clears
// the find). WebKit reports found or not, never a count.
import { useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { IconButton } from "../../ui/IconButton";

export function BrowserFindBar({ onFind, onClose }: {
  onFind: (text: string, backwards: boolean) => Promise<boolean | null>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"found" | "none" | null>(null);

  const step = async (backwards: boolean): Promise<void> => {
    if (text.trim() === "") return;
    const found = await onFind(text, backwards);
    setStatus(found === null ? null : found ? "found" : "none");
  };
  const key = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") { e.preventDefault(); void step(e.shiftKey); }
  };

  return (
    <div className="flex h-[34px] shrink-0 items-center gap-1.5 border-b border-[var(--v2-edge)] px-2.5">
      <label className="flex h-6 w-[280px] shrink-0 items-center gap-1.5 rounded-md border border-[var(--v2-accent-edge)] bg-[var(--v2-side)] px-2">
        <input autoFocus aria-label="Find in page" placeholder="Find in page" value={text}
          onChange={e => setText(e.target.value)} onKeyDown={key}
          className="v2-mono min-w-0 flex-1 border-0 bg-transparent text-v2-small text-[var(--v2-text)] outline-none" />
      </label>
      <span aria-live="polite" className="v2-mono w-[86px] shrink-0 text-v2-small text-[var(--v2-muted)]">
        {status === "found" ? "match found" : status === "none" ? "no match" : ""}
      </span>
      <IconButton label="Previous match" title="Previous match" size={22} disabled={text.trim() === ""} onClick={() => void step(true)}>
        <ChevronUp size={12} aria-hidden />
      </IconButton>
      <IconButton label="Next match" title="Next match" size={22} disabled={text.trim() === ""} onClick={() => void step(false)}>
        <ChevronDown size={12} aria-hidden />
      </IconButton>
      <span className="flex-1" />
      <IconButton label="Close find" title="Close find (Esc)" size={22} onClick={onClose}><X size={12} aria-hidden /></IconButton>
    </div>
  );
}
