export const PLAIN_WAKE_KICKOFF = "Recap from memory and the board, then continue the project.";
export const PRD_REVIEW_KICKOFF = "docs/PRD.md is the brief; run /trantor:prd-review";

export function slugProjectName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

/** The full project path under a PARENT root: `--dir <parent>` in `trantor new` means the name is
 *  ALWAYS appended, so the resulting project is `<root>/<name>` — never the parent itself. */
export function projectTarget(parentRoot: string, name: string): string {
  const root = parentRoot.replace(/\/+$/, "");
  return name ? `${root}/${name}` : root;
}

/** The sheet's FALLBACK kickoff only (#6112): `trantor genesis-kickoff` decides the real one and
 *  project_wake relays it. A brief means path B (the crew's PRD review), no brief path A. The brief
 *  itself never rides the prompt (a 291k-char PRD typed into a pane is the failure this replaces). */
export function genesisKickoff(brief: string, _droppedFrom?: string | null): string {
  return brief.trim() ? PRD_REVIEW_KICKOFF : PLAIN_WAKE_KICKOFF;
}
