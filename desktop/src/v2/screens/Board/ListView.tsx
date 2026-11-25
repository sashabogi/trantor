// The List view: one plain row per card, sorted by last touch (#13989).
import type { Card } from "../../../shared/api/client";
import type { PresenceState } from "../../../shared/presence";
import { cleanTitle } from "../../../shared/Avatar";
import { dictGet } from "../../../shared/dict";
import { Avatar } from "../../ui/Avatar";
import { Chip, type ChipTone } from "../../ui/Chip";
import { toPresence } from "./CardFace";
import { agoShort, checklistOf, touchedAt } from "./model";

const TONE = { todo: "neutral", doing: "info", testing: "warn", done: "ok", failed: "bad", blocked: "bad", stale: "neutral" } as const satisfies Record<string, ChipTone>;

export function ListView({ cards, presence, selected, onOpen }: {
  cards: Card[]; presence: Map<string, PresenceState>; selected: number | null; onOpen: (id: number) => void;
}) {
  const rows = [...cards].sort((a, b) => touchedAt(b) - touchedAt(a));
  if (!rows.length) return <div className="px-5 py-6 text-v2-base text-[var(--v2-muted)]">No cards match.</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
      <table className="w-full border-collapse text-left text-v2-body">
        <thead>
          <tr className="text-v2-small uppercase tracking-[0.06em] text-[var(--v2-muted)]">
            <th className="py-1.5 pr-3 font-semibold">Card</th><th className="pr-3 font-semibold">Status</th>
            <th className="pr-3 font-semibold">Seat</th><th className="pr-3 font-semibold">Model</th>
            <th className="pr-3 font-semibold">Acceptance</th><th className="font-semibold">Touched</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => {
            const chk = checklistOf(c);
            const seat = c.workedBy || c.assignee;
            return (
              <tr key={c.id} data-row={c.id} className={`border-t border-[var(--v2-edge)] ${selected === c.id ? "bg-[var(--v2-panel-2)]" : ""}`}>
                <td className="max-w-[420px] py-1.5 pr-3">
                  <button type="button" onClick={() => onOpen(c.id)} className="v2-hover flex w-full items-baseline gap-2 rounded border-0 bg-transparent p-0 text-left text-[var(--v2-text)]">
                    <span className="v2-mono shrink-0 text-v2-small text-[var(--v2-faint)]">#{c.id}</span>
                    <span className="min-w-0 flex-1 truncate">{c.summary || cleanTitle(c.title)}</span>
                  </button>
                </td>
                <td className="pr-3"><Chip tone={dictGet(TONE, c.status) ?? "neutral"}>{c.status}</Chip></td>
                <td className="pr-3">{seat ? <Avatar name={seat} size={18} presence={toPresence(c.assignee ? presence.get(c.assignee) : undefined)} surface="var(--v2-bg)" /> : <span className="text-[var(--v2-muted)]">unassigned</span>}</td>
                <td className="v2-mono pr-3 text-v2-small text-[var(--v2-muted)]">{c.model ?? ""}</td>
                <td className="pr-3 text-v2-small text-[var(--v2-muted)]">{chk ? `${chk.done}/${chk.total}` : ""}</td>
                <td className="text-v2-small text-[var(--v2-muted)]">{agoShort(c)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
