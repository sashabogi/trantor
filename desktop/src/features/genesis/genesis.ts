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

/** The sheet's FALLBACK kickoff only (#6112): `trantor genesis-kickoff` decides the real one from
 *  docs/PRD.md plus the signed board, relayed via project_wake; this fires only when that CLI
 *  cannot answer. A brief means path B (crew PRD review), no brief means path A (plain wake); the
 *  brief itself never rides the prompt. Second argument stays for #6120's call site. */
export function genesisKickoff(brief: string, _droppedFrom?: string | null): string {
  return brief.trim() ? PRD_REVIEW_KICKOFF : PLAIN_WAKE_KICKOFF;
}
