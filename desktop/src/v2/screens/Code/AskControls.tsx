// Header controls that send the open file or its selection to the chat (#14073).
import { MessageSquarePlus, Send } from "lucide-react";
import { MenuItem, Popover } from "../../shell/Popover";
import { IconButton } from "../../ui/IconButton";
import { seatLabel } from "../../ui/identity";
import { contextFromEditor, type AskEditor } from "./askContext";

export type AskSeat = { seat: string; label?: string };

export function AskControls({ getEditor, path, scope, seats = [], menuOpen, onMenuOpen, onAsk, onSendToSeat }: {
  getEditor: () => AskEditor | null; path: string; scope: string | null; seats?: AskSeat[];
  menuOpen: boolean; onMenuOpen: (open: boolean) => void;
  onAsk?: (text: string) => void; onSendToSeat?: (seat: string, text: string) => void;
}) {
  const text = () => { const ed = getEditor(); return ed ? contextFromEditor(ed, path, scope) : path; };
  return (
    <>
      <IconButton label="Ask about this" title="Add this file or the selection to the chat" size={24} onClick={() => onAsk?.(text())}>
        <MessageSquarePlus size={14} aria-hidden />
      </IconButton>
      {seats.length > 0 && (
        <div className="relative">
          <IconButton label="Send to a seat" title="Send this file or the selection to a seat" size={24} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => onMenuOpen(!menuOpen)}>
            <Send size={14} aria-hidden />
          </IconButton>
          <Popover open={menuOpen} onClose={() => onMenuOpen(false)} label="Send to a seat" align="right">
            {seats.map(s => (
              <MenuItem key={s.seat} onSelect={() => { onMenuOpen(false); onSendToSeat?.(s.seat, text()); }}>{s.label ?? seatLabel(s.seat)}</MenuItem>
            ))}
          </Popover>
        </div>
      )}
    </>
  );
}
