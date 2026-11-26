// The one-line message to a seat, delivered through the hub bus at its next turn boundary (#13987).
import { useState, type RefObject } from "react";
import { CornerDownLeft, TerminalSquare } from "lucide-react";
import type { HubClient } from "../../../shared/api/client";
import type { SeatView } from "./seatModel";

export function SeatMessage({ client, project, seat, inputRef }: {
  client: HubClient; project: string; seat: SeatView; inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const body = text.trim();
  const send = async () => {
    if (!body || state === "sending") return;
    setState("sending");
    try { await client.send(seat.session, body, project); setText(""); setState("sent"); }
    catch { setState("failed"); }
  };
  return (
    <div className="v2-composer mx-3 mb-2 mt-1.5 flex shrink-0 items-center gap-2 rounded-lg px-3 py-1">
      <label htmlFor="v2-seatmsg" className="sr-only">Message {seat.label}</label>
      <TerminalSquare size={13} className="shrink-0 text-[var(--v2-muted)]" aria-hidden />
      <input id="v2-seatmsg" ref={inputRef} type="text" value={text}
        onChange={e => { setText(e.target.value); if (state !== "idle") setState("idle"); }}
        onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
        placeholder={`Message ${seat.label} at its next turn`}
        className="v2-composer-field min-w-0 flex-1 border-0 bg-transparent py-1.5 text-v2-base text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-muted)]" />
      {state === "sent" && <span role="status" className="text-v2-small text-[var(--v2-ok)]">sent</span>}
      {state === "failed" && <span role="alert" className="text-v2-small text-[var(--v2-bad)]">not sent</span>}
      <button type="button" aria-label={`Send to ${seat.label}`} title="Send (delivered at its next turn boundary)"
        disabled={!body || state === "sending"} onClick={() => void send()}
        className="v2-hover inline-flex shrink-0 items-center gap-1 rounded-sm border border-[var(--v2-edge-2)] bg-transparent px-1.5 py-0.5 text-v2-small text-[var(--v2-text-2)] disabled:opacity-40">
        <CornerDownLeft size={11} aria-hidden />send
      </button>
    </div>
  );
}
