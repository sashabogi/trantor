// The way back to the newest message (#14327): a small pill above the composer, shown only while the
// reader is scrolled away from the foot. "N new" once messages have landed below.
import { ArrowDown } from "lucide-react";

export function LatestPill({ unseen, onClick }: { unseen: number; onClick: () => void }) {
  const fresh = unseen > 0;
  return (
    <button type="button" onClick={onClick} data-testid="latest-pill"
      aria-label={fresh ? "Jump to latest — new messages below" : "Jump to latest"}
      title={fresh ? "New messages below, jump to the latest" : "Jump to the latest"}
      className="v2-pop inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--v2-edge-2)] bg-[var(--v2-raised)] px-3 text-v2-body text-[var(--v2-text)] shadow-[var(--v2-shadow-menu)] transition-colors duration-[var(--v2-dur-1)] ease-[var(--v2-ease)] hover:border-[var(--v2-accent-edge)]">
      <ArrowDown size={12} aria-hidden />
      {fresh ? `${unseen} new` : "Latest"}
    </button>
  );
}
