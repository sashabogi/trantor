// The chat on the right (#13988): a folded rail by default so the diff keeps the width, and a
// Composer2 when open. "Add to chat" actions land in its draft; sending goes to a live session.
import { useState } from "react";
import { MessageSquare, PanelRightClose } from "lucide-react";
import type { HubClient, Peer } from "../../../shared/api/client";
import { Avatar } from "../../ui/Avatar";
import { Composer2 } from "../../ui/Composer2";
import { IconButton } from "../../ui/IconButton";
import { seatLabel } from "../../ui/identity";

export function pickTarget(peers: Peer[] | null, project: string, want: string | null): Peer | null {
  const mine = (peers ?? []).filter(p => p.project === project || p.session.endsWith(`:${project}`));
  if (want) return mine.find(p => p.session === want || p.session.startsWith(`${want}:`)) ?? null;
  return mine.find(p => /orchestrator/i.test(p.session)) ?? null;
}

export function ChatRail({ client, project, peers, open, onToggle, draft, onDraft, want }: {
  client: HubClient; project: string; peers: Peer[] | null; open: boolean; onToggle: () => void;
  draft: string; onDraft: (v: string) => void; want: string | null;
}) {
  const [note, setNote] = useState<string | null>(null);
  const target = pickTarget(peers, project, want);
  const name = target ? target.session.split(":")[0] : want ?? "orchestrator";
  if (!open) {
    return (
      <aside aria-label="Chat, folded" className="flex w-[46px] shrink-0 flex-col items-center gap-3 overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-chrome)] py-2.5">
        <IconButton label="Open the chat" title="Chat (folded). Click to open it" size={32} badge={draft.trim() ? 1 : null} badgeTone="info" onClick={onToggle}><MessageSquare size={16} aria-hidden /></IconButton>
        <Avatar name={name} size={24} />
      </aside>
    );
  }
  const send = (text: string) => {
    if (!target) return;
    client.send(target.session, text, project)
      .then(() => { onDraft(""); setNote(`Sent to ${seatLabel(name)}. Its replies land in the Workspace.`); })
      .catch(e => setNote(e instanceof Error ? e.message : String(e)));
  };
  return (
    <aside aria-label="Chat" className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)]">
      <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-3 py-2">
        <span className="flex-1 text-v2-base font-semibold">Chat</span>
        <span className="inline-flex items-center gap-1.5 text-v2-body text-[var(--v2-muted)]"><Avatar name={name} size={16} />{seatLabel(name)}</span>
        <IconButton label="Fold the chat" title="Fold the chat into the rail" size={26} onClick={onToggle}><PanelRightClose size={14} aria-hidden /></IconButton>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 text-v2-body leading-relaxed text-[var(--v2-muted)]">
        {draft.trim() ? "Your attachment is in the box below. Edit it, then send." : "Use Add to chat on a commit or a hunk to attach it here."}
        {note && <div role="status" className="mt-2 text-[var(--v2-text-2)]">{note}</div>}
      </div>
      <div className="border-t border-[var(--v2-edge)] p-3">
        <Composer2 value={draft} onChange={onDraft} onSend={send} label={`Message ${seatLabel(name)}`} placeholder="Plan, ask or build. Add a commit or hunk with Add to chat"
          agent={name} model={{ id: target?.model ?? "unknown", label: target?.model ?? "model unknown" }} contextPct={null}
          disabledReason={target ? null : `No ${seatLabel(name)} session is live in this project`} />
      </div>
    </aside>
  );
}
