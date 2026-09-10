// A project's own face in the sidebar, read from disk (Rust side, `project_icon`) rather than
// invented, since a list of same-looking text rows gives the eye nothing to land on. Projects
// without real art get a deterministic monogram in the Avatar primitive's hue family. Shapes
// carry meaning: agents and humans are CIRCLES (see Avatar), projects are ROUNDED SQUARES.
import { useEffect, useState } from "react";
import { projectIcon } from "./api/client";
import { hueOf } from "./Avatar";

// Module-level so switching panes never refetches — the answer is a file on disk that does not
// change while the app is open, and a sidebar re-render must not hit the filesystem again. `null`
// is a REAL cached answer ("this repo has no art"), which is why the map holds string | null and
// membership is tested with .has(), not truthiness.
const CACHE = new Map<string, string | null>();
const INFLIGHT = new Map<string, Promise<string | null>>();

function load(project: string): Promise<string | null> {
  if (CACHE.has(project)) return Promise.resolve(CACHE.get(project)!);
  const running = INFLIGHT.get(project);
  if (running) return running;
  const p = projectIcon(project)
    .then(v => { CACHE.set(project, v); INFLIGHT.delete(project); return v; })
    .catch(() => { CACHE.set(project, null); INFLIGHT.delete(project); return null; });
  INFLIGHT.set(project, p);
  return p;
}

/** "crm-platform" -> "CP", "crebral-health" -> "CH", "capowerball" -> "CA".
 * Two characters, always: initials for hyphenated names, since first-two-letters collides across
 * half this fleet; the first two letters for single-word names. Two-character collisions across
 * the full set are fine, since the tile's hue comes from the full name, not the monogram. */
export function monogramFor(project: string): string {
  const words = project.split(/[-_.\s]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0]! + words[1][0]!).toUpperCase();
}

export function ProjectIcon({ project, size = 20 }: { project: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(() => CACHE.get(project) ?? null);

  useEffect(() => {
    let alive = true;
    // Re-read the cache synchronously on project change so an already-known icon paints on the
    // first frame instead of flashing a monogram and swapping — that flicker down a whole sidebar
    // is worse than either state on its own.
    if (CACHE.has(project)) { setSrc(CACHE.get(project)!); return; }
    setSrc(null);
    void load(project).then(v => { if (alive) setSrc(v); });
    return () => { alive = false; };
  }, [project]);

  const radius = Math.max(4, Math.round(size * 0.28));

  if (src) {
    return (
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden bg-white/[0.04]"
        style={{ width: size, height: size, borderRadius: radius }}>
        <img
          src={src}
          alt=""
          draggable={false}
          // A broken/undecodable asset (a malformed .ico is the realistic case) must fall back to
          // the monogram, not leave a torn-image glyph in the nav.
          onError={() => { CACHE.set(project, null); setSrc(null); }}
          style={{ width: size, height: size, objectFit: "cover" }}
        />
      </span>
    );
  }

  const h = hueOf(project);
  return (
    <span
      className="flex shrink-0 items-center justify-center font-semibold"
      style={{
        width: size, height: size, borderRadius: radius,
        fontSize: size * 0.42, letterSpacing: "-0.02em",
        background: `hsl(${h} 30% 24%)`, color: `hsl(${h} 60% 74%)`,
      }}>
      {monogramFor(project)}
    </span>
  );
}
