import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Avatar, Button, Chip, Composer2, IconButton, ProjectTile, seatLabel } from "../../index";
import { markSeen } from "../../../shared/seen";
import { ago } from "../../../shared/time";
import type { Card, HubClient, Peer } from "../../../shared/api/client";
import type { HoldItem, InboxItem, MessageItem, ProposalItem } from "./model";

export const QUICK_ANSWERS = ["Go ahead", "No", "Hold off for now"] as const;

type DetailProps = {
  client: HubClient;
  item: InboxItem;
  cards: Card[];
  peers: Peer[];
  onSettled: (item: InboxItem) => void;
  onOpenConversation: () => void;
  onOpenCard: (project: string) => void;
};

function CardRefs({ item, cards, onOpenCard }: { item: MessageItem; cards: Card[]; onOpenCard: (project: string) => void }) {
  const refs = item.message.refs ?? [];
  if (!refs.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {refs.map(id => {
        const card = cards.find(candidate => candidate.id === id);
        return (
          <button key={id} type="button" title={card ? `${card.title} · ${card.status}` : `Open card #${id}`} onClick={() => onOpenCard(item.project)}
            className="v2-hover rounded-md border-0 bg-transparent p-0">
            <Chip tone={card && ["done", "failed", "stale", "cancelled"].includes(card.status) ? "neutral" : "info"} mono>
              #{id}{card ? ` · ${card.status}` : ""}
            </Chip>
          </button>
        );
      })}
    </div>
  );
}

function MessageDetail({ client, item, cards, onSettled, onOpenCard }: Omit<DetailProps, "peers" | "onOpenConversation"> & { item: MessageItem }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answerAnyway, setAnswerAnyway] = useState(false);
  const blocked = item.stale.stale && !answerAnyway;
  const reply = async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || busy || blocked) return;
    setBusy(true); setError("");
    try {
      await client.send(item.message.from, trimmed, item.message.project);
      setText("");
      markSeen(item.message.id);
      void client.delivered(item.message.id);
      onSettled(item);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  return (
    <>
      {item.stale.stale && (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--v2-edge)] p-2.5 text-v2-body text-[var(--v2-muted)]">
          <span className="flex-1">stale — {item.stale.reason}</span>
          {!answerAnyway && <Button onClick={() => setAnswerAnyway(true)}>Answer anyway</Button>}
        </div>
      )}
      {item.message.text !== item.title && <div className="whitespace-pre-wrap break-words rounded-[4px_12px_12px_12px] border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] p-3 leading-[1.55] text-[var(--v2-text-2)]">{item.message.text}</div>}
      <CardRefs item={item} cards={cards} onOpenCard={onOpenCard} />
      {!blocked && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-v2-small text-[var(--v2-muted)]">Quick answer</span>
            {QUICK_ANSWERS.map(answer => <Button key={answer} disabledReason={busy ? "Sending…" : null} onClick={() => void reply(answer)}>{answer}</Button>)}
            <span className="flex-1" /><span className="text-v2-small text-[var(--v2-muted)]">⏎ send</span>
          </div>
          <Composer2 value={text} onChange={setText} onSend={value => void reply(value)}
            label={`Answer ${seatLabel(item.from)}`} placeholder={`Answer ${seatLabel(item.from)} in your own words (it reads this as the answer)`}
            agent={item.from} model={{ id: "not-reported", label: "model not reported" }} contextPct={null}
            disabledReason={busy ? "Sending…" : null} />
        </>
      )}
      {error && <p role="alert" className="m-0 text-v2-body text-[var(--v2-bad)]">{error}</p>}
    </>
  );
}

function ProposalDetail({ client, item, onSettled }: { client: HubClient; item: ProposalItem; onSettled: (item: InboxItem) => void }) {
  const [busy, setBusy] = useState(false);
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const decide = async (status: "approved" | "denied") => {
    if (busy || (status === "denied" && !note.trim())) return;
    setBusy(true); setError("");
    try {
      await client.decideProposal(item.proposal.id, status, status === "denied" ? note.trim() : undefined);
      onSettled(item);
    } catch { setError("Decision could not be saved. Try again."); }
    finally { setBusy(false); }
  };
  return (
    <>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-lg border border-[var(--v2-edge)] p-3 text-v2-body">
        <dt className="text-[var(--v2-muted)]">scope</dt><dd className="m-0 break-words">{item.proposal.scope}</dd>
        <dt className="text-[var(--v2-muted)]">when</dt><dd className="m-0 break-words">{item.proposal.condition}</dd>
        <dt className="text-[var(--v2-muted)]">not covered</dt><dd className="m-0 break-words">{item.proposal.exclusions}</dd>
      </dl>
      {denying ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="v2-deny-note" className="text-v2-small text-[var(--v2-muted)]">Why not? The agent remembers this…</label>
          <textarea id="v2-deny-note" autoFocus value={note} onChange={event => setNote(event.target.value)} rows={2}
            className="resize-none rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-2 text-v2-body text-[var(--v2-text)]" />
          <div><Button variant="danger" disabledReason={busy || !note.trim() ? "A denial needs a note" : null} onClick={() => void decide("denied")}>Deny</Button></div>
        </div>
      ) : (
        <div className="flex gap-2"><Button disabledReason={busy ? "Saving…" : null} onClick={() => void decide("approved")}>Approve</Button><Button disabledReason={busy ? "Saving…" : null} onClick={() => setDenying(true)}>Deny…</Button></div>
      )}
      {error && <p role="alert" className="m-0 text-v2-body text-[var(--v2-bad)]">{error}</p>}
    </>
  );
}

function HoldDetail({ client, item, onSettled }: { client: HubClient; item: HoldItem; onSettled: (item: InboxItem) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decide = async (status: "go" | "nogo") => {
    setBusy(true); setError("");
    try { await client.decideHold(item.hold, status); onSettled(item); }
    catch { setError("Decision could not be saved. Try again."); }
    finally { setBusy(false); }
  };
  return (
    <>
      <p className="m-0 text-v2-base leading-[1.55] text-[var(--v2-text-2)]">{item.hold.session} is held by {item.hold.other}’s claim on <span className="v2-mono">{item.hold.file}</span>. Go permits the edit. No-go keeps it held until the earlier claim ends.</p>
      <div className="flex gap-2"><Button disabledReason={busy ? "Saving…" : null} onClick={() => void decide("go")}>Go</Button><Button variant="danger" disabledReason={busy ? "Saving…" : null} onClick={() => void decide("nogo")}>No-go</Button></div>
      {error && <p role="alert" className="m-0 text-v2-body text-[var(--v2-bad)]">{error}</p>}
    </>
  );
}

export function InboxDetail(props: DetailProps) {
  const { item, peers, onOpenConversation } = props;
  const peer = peers.find(candidate => candidate.session === item.from);
  const sender = item.kind === "collision" ? item.hold.session : item.from;
  return (
    <section aria-label={`${item.kind} from ${seatLabel(sender)}`} className="flex min-w-0 flex-1 flex-col bg-[var(--v2-bg)]">
      <header className="flex flex-col gap-2.5 border-b border-[var(--v2-edge)] px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 text-v2-body text-[var(--v2-muted)]">
          {item.project && <><ProjectTile name={item.project} size={18} />{item.project}<span>·</span></>}
          <span className="capitalize">{item.kind}</span><span>· asked {ago(item.ts)} · waiting on you {ago(item.ts)}</span><span className="flex-1" />
          <IconButton label="Open the conversation" title={`Open the whole conversation with ${seatLabel(sender)}`} variant="outline" onClick={onOpenConversation}><ExternalLink size={13} aria-hidden /></IconButton>
        </div>
        <h2 className="m-0 text-v2-title font-semibold leading-[1.35]">{item.title}</h2>
        <div className="flex flex-wrap items-center gap-2 text-v2-body text-[var(--v2-muted)]">
          <Avatar name={sender} size={20} /><span className="text-[var(--v2-text)]">{seatLabel(sender)}</span>
          {peer?.model && <span>· {peer.model}</span>}{peer?.machine && <span>on {peer.machine}</span>}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        <div>
          <div className="mb-1.5 text-v2-small font-semibold tracking-[0.08em] text-[var(--v2-muted)]">WHAT YOUR ANSWER UNBLOCKS</div>
          <Chip tone="warn">{item.unblockLabel}</Chip>
        </div>
        {item.kind === "question" && <MessageDetail {...props} item={item} />}
        {item.kind === "proposal" && <ProposalDetail client={props.client} item={item} onSettled={props.onSettled} />}
        {item.kind === "collision" && <HoldDetail client={props.client} item={item} onSettled={props.onSettled} />}
      </div>
    </section>
  );
}

export function EmptyInboxDetail() {
  return (
    <section aria-label="No inbox item selected" className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 p-10 text-center">
      <span className="text-v2-base">Nothing waiting on you.</span>
      <span className="text-v2-body text-[var(--v2-muted)]">Agent-to-agent traffic lives in each project's conversation.</span>
    </section>
  );
}
