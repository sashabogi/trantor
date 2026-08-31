// A provider's brand mark: the vendored SVG glyph tinted in its brand hue, falling back to
// the monogram circle when no mark is vendored. Extracted from BalanceStrip so the Usage
// popover's roster rows and drill-in share the exact same rendering as the footer chips —
// one mark, three surfaces, no drift.
import { BRAND_PATHS } from "./brands";

export function BrandMark({ icon, mono, hue, fg }: { icon: string | null; mono: string; hue: string; fg: string }) {
  const d = icon ? BRAND_PATHS[icon] : undefined;
  if (d) {
    return (
      <svg viewBox="0 0 24 24" width={13} height={13} className="shrink-0" style={{ color: hue }} aria-hidden>
        <path d={d} fill="currentColor" fillRule="evenodd" />
      </svg>
    );
  }
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full"
      style={{ backgroundColor: hue, color: fg }}>
      <span className="text-[7px] font-semibold leading-none">{mono}</span>
    </span>
  );
}
