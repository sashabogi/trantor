// The path → language-server mapping, pure and Monaco/Tauri-free so it is unit-testable without
// booting the editor or the bridge. The editor's own `monacoLanguageFor` decides the language id;
// this decides which of those ids a server actually serves, and what its binary is called.
import { monacoLanguageFor } from "./editorLanguage";

const SERVED = new Set(["rust", "typescript", "javascript", "python"]);

/** The LSP language id for a path, or null when no server serves that file. */
export function lspLanguageFor(path: string): string | null {
  const lang = monacoLanguageFor(path);
  return SERVED.has(lang) ? lang : null;
}

/** The binary name behind a language — what the honest status line names. */
export function lspServerName(language: string): string {
  switch (language) {
    case "rust": return "rust-analyzer";
    case "typescript":
    case "typescriptreact":
    case "javascript": return "typescript-language-server";
    case "python": return "pyright-langserver";
    default: return language;
  }
}
