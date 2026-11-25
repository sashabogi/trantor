import type { ReactNode } from "react";

export type ChipTone = "neutral" | "ok" | "warn" | "bad" | "info";

const TONE = {
  neutral: { bg: "var(--v2-panel-2)", border: "var(--v2-edge)", fg: "var(--v2-text-2)" },
  ok: { bg: "var(--v2-ok-soft)", border: "var(--v2-ok-edge)", fg: "var(--v2-ok)" },
  warn: { bg: "var(--v2-warn-soft)", border: "var(--v2-warn-edge)", fg: "var(--v2-warn)" },
  bad: { bg: "var(--v2-bad-soft)", border: "var(--v2-bad-edge)", fg: "var(--v2-bad)" },
  info: { bg: "var(--v2-accent-soft)", border: "var(--v2-info-edge)", fg: "var(--v2-accent-hi)" },
} as const satisfies Record<ChipTone, { bg: string; border: string; fg: string }>;

export type ChipProps = {
  tone?: ChipTone;
  icon?: ReactNode;
  /** Monospace text, for branches, ids and numbers. */
  mono?: boolean;
  title?: string;
  children: ReactNode;
};

export function Chip({ tone = "neutral", icon, mono, title, children }: ChipProps) {
  const t = TONE[tone];
  return (
    <span data-tone={tone} title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-[7px] py-[2px] text-[11px] font-medium ${mono ? "v2-mono" : ""}`}
      style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.fg }}>
      {icon}{children}
    </span>
  );
}
