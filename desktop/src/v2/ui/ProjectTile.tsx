import { monogram, PRESENCE_COLOR, projectGradient, type Presence } from "./identity";

export type ProjectTileProps = {
  name: string;
  /** Square side in px (artboards: 22 top bar, 26 rail, 34 project header). */
  size?: number;
  /** Corner dot, e.g. needs-you amber on the rail. */
  dot?: Presence;
};

/** Decorative: the button or link around it carries the accessible name. */
export function ProjectTile({ name, size = 26, dot }: ProjectTileProps) {
  return (
    <span aria-hidden data-project-tile={name}
      className="relative inline-flex shrink-0 items-center justify-center font-bold text-[var(--v2-text)]"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.27), background: projectGradient(name),
        fontSize: Math.max(9, Math.round(size * 0.37)) }}>
      {monogram(name)}
      {dot && (
        <span data-dot={dot} className="absolute rounded-full"
          style={{ width: 8, height: 8, top: -3, right: -3, background: PRESENCE_COLOR[dot], border: "2px solid var(--v2-chrome)" }} />
      )}
    </span>
  );
}
