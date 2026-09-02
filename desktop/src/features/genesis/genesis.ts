export const PLAIN_WAKE_KICKOFF = "Recap from memory and the board, then continue the project.";
export const GENESIS_RECAP_LINE = "Recap this brief and the board, then make a plan before starting work.";

export function slugProjectName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

export function projectTarget(devRoot: string, name: string): string {
  const root = devRoot.replace(/\/+$/, "");
  return name ? `${root}/${name}` : root;
}

export function genesisKickoff(brief: string): string {
  if (!brief) return GENESIS_RECAP_LINE;
  return `${brief}${brief.endsWith("\n") ? "" : "\n"}${GENESIS_RECAP_LINE}`;
}
