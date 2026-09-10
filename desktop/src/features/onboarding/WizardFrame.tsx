// Guided-flow chrome shared by the first-run wizard (#6392) and Drill Mode (#6800): icon,
// title/sub-line, "n / N" progress, scrolling body, footer buttons. Extracted from
// OnboardingFlow so the second flow reuses the frame instead of a near-copy. `dock` layout
// leaves the app clickable behind it, for drill steps that need the operator to act in the app.
import type { ReactNode } from "react";

export function WizardFrame({ icon, title, sub, index, total, layout = "modal", hidden = false, children, footer }: {
  icon: ReactNode;
  title: string;
  sub: string;
  index: number;
  total: number;
  layout?: "modal" | "dock";
  /** Drill Mode hides its own panel for the instant a screenshot is taken, so the evidence
   *  shows the app, not the checklist. */
  hidden?: boolean;
  children: ReactNode;
  footer: ReactNode;
}) {
  const shell = layout === "modal"
    ? "fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-tr-bg)]"
    : "pointer-events-none fixed inset-0 z-40 flex items-end justify-end p-4";
  const card = layout === "modal"
    ? "tr-card flex max-h-[86vh] w-[640px] max-w-[calc(100vw-48px)] flex-col overflow-hidden p-0 shadow-2xl"
    : "tr-card pointer-events-auto flex max-h-[70vh] w-[420px] max-w-[calc(100vw-32px)] flex-col overflow-hidden p-0 shadow-2xl";
  return (
    <div className={shell} style={hidden ? { visibility: "hidden" } : undefined} data-testid="wizard-frame">
      <div className={card}>
        <div className="flex items-center gap-3 border-b border-[var(--color-tr-edge)] px-6 py-4">
          <span className="rounded-lg bg-tr-doing/10 p-2 text-tr-doing">{icon}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">{title}</div>
            <div className="mt-0.5 text-[11.5px] text-[var(--color-tr-muted)]">{sub}</div>
          </div>
          <div className="tr-mono shrink-0 text-[11px] text-[var(--color-tr-muted)]">{index + 1} / {total}</div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-tr-edge)] px-6 py-3">{footer}</div>
      </div>
    </div>
  );
}
