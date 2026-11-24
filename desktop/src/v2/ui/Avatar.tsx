import { brandFor } from "../../shared/Avatar";
import { monogram, PRESENCE_COLOR, PRESENCE_LABEL, seatLabel, seatPalette, type Presence } from "./identity";

export type AvatarProps = {
  /** Seat or person name; "codex-8" renders C8 in the codex palette. */
  name: string;
  /** Diameter in px (artboards use 18, 22 and 28). */
  size?: number;
  presence?: Presence;
  /** The agent brand when the name does not carry it ("orchestrator" hosted by codex). */
  llm?: string;
  /** Colour of the ring around the presence dot: the surface the avatar sits on. */
  surface?: string;
};

export function Avatar({ name, size = 22, presence, surface = "var(--v2-panel-2)", llm }: AvatarProps) {
  const { bg, fg } = seatPalette(name);
  // #13984 drill: seats wear their vendor's real mark, as the bottom bar does; a monogram only when there is none.
  const brand = brandFor(name, llm);
  const dot = Math.max(6, Math.round(size * 0.36));
  const label = presence ? `${seatLabel(name)}, ${PRESENCE_LABEL[presence]}` : seatLabel(name);
  return (
    <span role="img" aria-label={label} title={label}
      className="relative inline-flex shrink-0 items-center justify-center rounded-full font-bold"
      style={{ width: size, height: size, background: brand ? "var(--v2-raised)" : bg, color: brand ? brand.hex : fg, fontSize: Math.max(7, Math.round(size * 0.4)) }}>
      {brand
        ? <span aria-hidden data-brand={brand.label} style={{ fontSize: Math.round(size * 0.62), lineHeight: 0, display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: brand.svg }} />
        : <span aria-hidden>{monogram(name)}</span>}
      {presence && (
        <span data-presence={presence} aria-hidden className="absolute rounded-full"
          style={{ width: dot, height: dot, right: -1, bottom: -1, background: PRESENCE_COLOR[presence], border: `2px solid ${surface}` }} />
      )}
    </span>
  );
}
