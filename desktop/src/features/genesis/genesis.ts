export const PLAIN_WAKE_KICKOFF = "Recap from memory and the board, then continue the project.";

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

export function genesisKickoff(brief: string, droppedFrom?: string | null): string {
  const normalizedBrief = brief.replace(/\r\n?|\n/g, "\n");
  const lineCount = normalizedBrief
    ? normalizedBrief.split("\n").length - Number(normalizedBrief.endsWith("\n"))
    : 0;
  const filename = droppedFrom?.replace(/\s+/g, " ").trim().slice(0, 120);
  const source = filename ? `dropped from ${filename}` : "entered in the Genesis sheet";
  const lines = lineCount === 1 ? "1 line" : `${lineCount} lines`;
  return `Your brief is in CLAUDE.md (${lines}, ${source}). Read it, recap it in three sentences, and propose a plan.`;
}
