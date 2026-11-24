// The one-line message to a seat, delivered through the hub bus at its next turn boundary (#13987).
import { useState, type RefObject } from "react";
import { ArrowUp, Paperclip, TerminalSquare } from "lucide-react";
import type { HubClient } from "../../../shared/api/client";
import { IconButton } from "../../ui/IconButton";
import type { SeatView } from "./seatModel";

export function SeatMessage({ client, project, seat, inputRef }: {
  client: HubClient; project: string; seat: SeatView; inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const reason = seat.isOrchestrator ? "Talk to the orchestrator in the chat panel on the right" : null;
  const body = text.trim();
  const send = async () => {
    if (!body || reason || state === "sending") return;
    setState("sending");
    try { await client.send(seat.session, body, project); setText(""); setState("sent"); }
    catch { setState("failed"); }
  };
  return (
    <div className="flex items-center gap-2 border-t border-[var(--v2-edge)] bg-[#111316] px-3 py-2">
      <label htmlFor="v2-seatmsg" className="sr-only">Message {seat.label}</label>
      <TerminalSquare size={13} className="shrink-0 text-[var(--v2-muted)]" aria-hidden />
      <input id="v2-seatmsg" ref={inputRef} type="text" value={text} disabled={!!reason}
        onChange={e => { setText(e.target.value); if (state !== "idle") setState("idle"); }}
        onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
        placeholder={reason ?? `Message ${seat.label} (it gets this at its next turn boundary)`}
        className="min-w-0 flex-1 border-0 bg-transparent py-1.5 text-[12.5px] text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-muted)]" />
      {state === "sent" && <span role="status" className="text-[11px] text-[var(--v2-ok)]">sent</span>}
      {state === "failed" && <span role="alert" className="text-[11px] text-[var(--v2-bad)]">not sent</span>}
      <IconButton label={`Attach a file or image for ${seat.label}`} title="Attaching is not wired for seat messages yet" size={26} round disabled>
        <Paperclip size={13} aria-hidden />
      </IconButton>
      <button type="button" aria-label={`Send to ${seat.label}`} title={reason ?? "Send (delivered at its next turn boundary)"}
        disabled={!body || !!reason || state === "sending"} onClick={() => void send()}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-0 bg-[var(--v2-text)] text-[var(--v2-ink)] disabled:opacity-40">
        <ArrowUp size={13} strokeWidth={2.4} aria-hidden />
      </button>
    </div>
  );
}
