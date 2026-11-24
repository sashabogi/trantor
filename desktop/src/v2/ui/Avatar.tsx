import { monogram, PRESENCE_COLOR, PRESENCE_LABEL, seatLabel, seatPalette, type Presence } from "./identity";

export type AvatarProps = {
  /** Seat or person name; "codex-8" renders C8 in the codex palette. */
  name: string;
  /** Diameter in px (artboards use 18, 22 and 28). */
  size?: number;
  presence?: Presence;
  /** Colour of the ring around the presence dot: the surface the avatar sits on. */
  surface?: string;
};

export function Avatar({ name, size = 22, presence, surface = "var(--v2-panel-2)" }: AvatarProps) {
  const { bg, fg } = seatPalette(name);
  const dot = Math.max(6, Math.round(size * 0.36));
  const label = presence ? `${seatLabel(name)}, ${PRESENCE_LABEL[presence]}` : seatLabel(name);
  return (
    <span role="img" aria-label={label} title={label}
      className="relative inline-flex shrink-0 items-center justify-center rounded-full font-bold"
      style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.max(7, Math.round(size * 0.4)) }}>
      <span aria-hidden>{monogram(name)}</span>
      {presence && (
        <span data-presence={presence} aria-hidden className="absolute rounded-full"
          style={{ width: dot, height: dot, right: -1, bottom: -1, background: PRESENCE_COLOR[presence], border: `2px solid ${surface}` }} />
      )}
    </span>
  );
}
