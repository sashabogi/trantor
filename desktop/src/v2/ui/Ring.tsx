export type RingProps = {
  /** Context used, 0 to 100; out-of-range values clamp. */
  pct: number;
  size?: number;
  /** Turns amber at or past this percent (the artboards hand off at 80, warn at 75). */
  warnAt?: number;
  title?: string;
};

const R = 10.5;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function Ring({ pct, size = 26, warnAt = 75, title }: RingProps) {
  const p = Math.round(Math.max(0, Math.min(100, pct)));
  const warn = p >= warnAt;
  const stroke = warn ? "var(--v2-warn)" : "var(--v2-accent)";
  const tip = title ?? `Context ${p}% used · hand off suggested at 80%`;
  return (
    <svg role="img" aria-label={`Context ${p} percent used`} data-warn={warn || undefined}
      width={size} height={size} viewBox="0 0 26 26" className="shrink-0">
      <title>{tip}</title>
      <circle cx="13" cy="13" r={R} fill="none" stroke="var(--v2-edge-2)" strokeWidth="2.5" />
      <circle cx="13" cy="13" r={R} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${((p / 100) * CIRCUMFERENCE).toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`} transform="rotate(-90 13 13)" />
      <text x="13" y="16" textAnchor="middle" fill={warn ? "var(--v2-warn)" : "var(--v2-text-2)"}
        fontFamily="Inter, sans-serif" fontSize="7.5" fontWeight="600">{p}</text>
    </svg>
  );
}
