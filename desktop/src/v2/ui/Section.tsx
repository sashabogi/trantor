import { useId, type ReactNode } from "react";

export type SectionProps = {
  title: string;
  sub?: ReactNode;
  /** Right side of the header: buttons, a count, a link. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Drop the inner padding for edge-to-edge lists. */
  flush?: boolean;
};

export function Section({ title, sub, actions, children, flush }: SectionProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel)]">
      <header className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-[14px] py-[10px]">
        <div className="min-w-0 flex-1">
          <h2 id={id} className="m-0 text-v2-base font-semibold text-[var(--v2-text)]">{title}</h2>
          {sub && <div className="mt-0.5 text-v2-body text-[var(--v2-muted)]">{sub}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>
      <div className={flush ? "" : "p-[14px]"}>{children}</div>
    </section>
  );
}
