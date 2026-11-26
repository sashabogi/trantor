import { useProjectIcon } from "../../shared/ProjectIcon";
import { monogram, PRESENCE_COLOR, projectGradient, type Presence } from "./identity";

export type ProjectTileProps = {
  name: string;
  /** Square side in px (artboards: 22 top bar, 26 rail, 34 project header). */
  size?: number;
  /** Corner dot, e.g. needs-you amber on the rail. */
  dot?: Presence;
};

/** Decorative: the button or link around it carries the accessible name. */
/** A project wears its own face when its repo ships one (an app icon, logo or touch icon, found by
 *  the Rust project_icon command); otherwise the gradient monogram. */
export function ProjectTile({ name, size = 26, dot }: ProjectTileProps) {
  const { src, broken } = useProjectIcon(name);
  const radius = Math.round(size * 0.27);
  return (
    <span aria-hidden data-project-tile={name} data-art={src ? "repo" : "monogram"}
      className="relative inline-flex shrink-0 items-center justify-center font-bold text-[var(--v2-text)]"
      style={{ width: size, height: size, borderRadius: radius, background: src ? "var(--v2-raised)" : projectGradient(name),
        fontSize: Math.max(9, Math.round(size * 0.37)) }}>
      {src
        ? <img src={src} alt="" draggable={false} onError={broken}
            style={{ width: size, height: size, borderRadius: radius, objectFit: "cover" }} />
        : monogram(name)}
      {dot && (
        <span data-dot={dot} className="absolute rounded-full"
          style={{ width: 8, height: 8, top: -3, right: -3, background: PRESENCE_COLOR[dot], border: "2px solid var(--v2-chrome)" }} />
      )}
    </span>
  );
}
