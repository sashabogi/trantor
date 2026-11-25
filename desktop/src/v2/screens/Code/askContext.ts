// The chat text for "ask about this" (#14073): a path, an optional line range, and the selected code fenced.
export type AskSelection = { startLine: number; startColumn: number; endLine: number; endColumn: number; text: string };

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

/** The narrow slice of a Monaco editor the ask controls read, so tests can fake it (#14073). */
export type AskEditor = {
  getSelection(): Range | null;
  getModel(): { getValueInRange(r: Range): string } | null;
};

export const MAX_ASK_LINES = 200;

function fenceFor(code: string): string {
  const runs = code.match(/`+/g) ?? [];
  return "`".repeat(Math.max(3, ...runs.map(r => r.length + 1)));
}

export function buildAskContext(path: string, scope: string | null, sel: AskSelection | null): string {
  const tag = scope ? ` (seat ${scope})` : "";
  if (!sel || sel.text.length === 0) return `${path}${tag}`;
  // Selecting whole lines ends at column 1 of the next line, which is not part of the selection.
  const wholeLines = sel.endColumn === 1 && sel.endLine > sel.startLine;
  const end = wholeLines ? sel.endLine - 1 : sel.endLine;
  const range = end === sel.startLine ? `${sel.startLine}` : `${sel.startLine}-${end}`;
  const body = wholeLines ? sel.text.replace(/\r?\n$/, "") : sel.text;
  const lines = body.split("\n");
  const shown = lines.slice(0, MAX_ASK_LINES).join("\n");
  const fence = fenceFor(shown);
  const more = lines.length - MAX_ASK_LINES;
  const tail = more > 0 ? `\nand ${more} more lines` : "";
  return `${path}:${range}${tag}\n${fence}\n${shown}\n${fence}${tail}`;
}

export function contextFromEditor(ed: AskEditor, path: string, scope: string | null): string {
  const s = ed.getSelection();
  const text = s ? ed.getModel()?.getValueInRange(s) ?? "" : "";
  const sel = s && text ? { startLine: s.startLineNumber, startColumn: s.startColumn, endLine: s.endLineNumber, endColumn: s.endColumn, text } : null;
  return buildAskContext(path, scope, sel);
}
