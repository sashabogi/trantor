// Small shared pieces of the Code screen (#13988).
import type { ReactNode } from "react";

/** The honest "not wired yet" block: says what is missing and which command it needs. */
export function NotWiredBlock({ title, line }: { title: string; line: string }) {
  return (
    <div data-not-wired role="note" className="rounded-lg border border-dashed border-[var(--v2-edge-2)] px-3.5 py-3 text-v2-body leading-relaxed text-[var(--v2-muted)]">
      <div className="mb-0.5 text-v2-base font-semibold text-[var(--v2-text-2)]">{title}</div>
      {line}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-1 pt-2.5 text-v2-small font-semibold uppercase tracking-[0.06em] text-[var(--v2-muted)]">{children}</div>;
}

/** +N −N in the diff colours; renders nothing when git counted nothing. */
export function Counts({ plus, minus }: { plus: number | null; minus: number | null }) {
  if (plus === null || minus === null) return null;
  return (
    <span className="v2-mono shrink-0 text-v2-small tabular-nums">
      {plus > 0 && <span className="text-[var(--v2-ok)]">+{plus}</span>}{plus > 0 && minus > 0 && " "}
      {minus > 0 && <span className="text-[var(--v2-bad)]">−{minus}</span>}
    </span>
  );
}

const LETTER_TONE = { A: "var(--v2-ok)", D: "var(--v2-bad)", R: "var(--v2-accent)", M: "var(--v2-warn)", U: "var(--v2-ok)" } as const;

export function StatusLetter({ letter }: { letter: "A" | "D" | "R" | "M" | "U" }) {
  return <span className="v2-mono w-3 shrink-0 text-center text-v2-small font-semibold" style={{ color: LETTER_TONE[letter] }}>{letter}</span>;
}

/** Beside the branch name whenever git acts on the project's main checkout, not a seat (#13988 drill). */
export function MainCheckoutMark() {
  return <span data-main-checkout className="ml-1.5 shrink-0 rounded border border-[var(--v2-edge-2)] px-1 text-v2-micro font-normal text-[var(--v2-muted)]">main checkout</span>;
}

/** "name  dir" with the file name leading, the way the artboards lay a changed row out. */
export function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  return (
    <span className="min-w-0 flex-1 truncate">
      <span className="text-[var(--v2-text)]">{cut < 0 ? path : path.slice(cut + 1)}</span>
      {cut > 0 && <span className="ml-1.5 text-v2-small text-[var(--v2-muted)]">{path.slice(0, cut)}</span>}
    </span>
  );
}
