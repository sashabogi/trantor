// The path → Monaco language id mapping. Pure and Monaco-free so it is unit-testable without
// booting the editor. Same mapping the CodeMirror `languageFor` had (CodeView.tsx:26-34), with
// the same philosophy: unknown extensions get plaintext rather than a wrong, authoritative-
// looking guess. The old one mode lumped ts and js into one mode; Monaco has real ids for both.
export function monacoLanguageFor(path: string): string {
  const p = path.toLowerCase();
  if (/\.(ts|tsx|mts|cts)$/.test(p)) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(p)) return "javascript";
  if (/\.rs$/.test(p)) return "rust";
  if (/\.(md|markdown)$/.test(p)) return "markdown";
  if (/\.py$/.test(p)) return "python";
  if (/\.(json|lock)$/.test(p)) return "json";
  return "plaintext";
}
