// The model dial's label at 440px (#5841): "claude-fable-5-1" is 16 characters of chrome for
// one fact. The operator's rule (2026-09-01): the brand mark says WHOSE model, the version says
// which — "5.1" beside the Claude mark. The family and the full id ride the tooltip.

export type ModelLabel = { brand: "claude" | null; short: string; full: string };

const CLAUDE = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/;

export function modelLabel(id: string): ModelLabel {
  const m = CLAUDE.exec(id);
  if (!m) return { brand: null, short: id, full: id };
  const version = m[3] ? `${m[2]}.${m[3]}` : m[2];
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return { brand: "claude", short: version, full: `${family} ${version} (${id})` };
}
