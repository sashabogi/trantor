import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";

const DEBOUNCE_MS = 300;
const LINES_BEFORE = 60;
const LINES_AFTER = 20;
const STORAGE_KEY = "code.ghostText";

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function getEnabled(): boolean {
  try {
    // OFF until the operator turns it on: measured 2026-09-01, a scrooge CLI completion takes
    // 16 to 36 seconds end to end, which is not ghost text. The fast path is its own card.
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function setEnabled(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
  } catch { /* private mode */ }
}

export function isGhostTextEnabled(): boolean {
  return getEnabled();
}

export function toggleGhostText(): boolean {
  const next = !getEnabled();
  setEnabled(next);
  return next;
}

function extractContext(model: monaco.editor.ITextModel, position: monaco.Position) {
  const totalLines = model.getLineCount();
  const startLine = Math.max(1, position.lineNumber - LINES_BEFORE);
  const endLine = Math.min(totalLines, position.lineNumber + LINES_AFTER);

  const prefixLines: string[] = [];
  for (let i = startLine; i <= position.lineNumber; i++) {
    prefixLines.push(model.getLineContent(i));
  }
  const prefix = prefixLines.join("\n");

  const suffixLines: string[] = [];
  for (let i = position.lineNumber + 1; i <= endLine; i++) {
    suffixLines.push(model.getLineContent(i));
  }
  const suffix = suffixLines.join("\n");

  return { prefix, suffix };
}

export function registerGhostTextProvider(
  _model: monaco.editor.ITextModel,
): monaco.IDisposable {
  const provider: monaco.languages.InlineCompletionsProvider = {
    // nothing to release per request: the completion is a plain string
    disposeInlineCompletions() {},
    provideInlineCompletions(model, position, _context, token) {
      if (!getEnabled()) return Promise.resolve({ items: [] });
      if (token.isCancellationRequested) return Promise.resolve({ items: [] });

      const { prefix, suffix } = extractContext(model, position);
      const path = model.uri.path;

      return new Promise((resolve) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          invoke<string>("ghost_complete", { prefix, suffix, path })
            .then((completion) => {
              if (!completion || !completion.trim()) {
                resolve({ items: [] });
                return;
              }
              // Monaco's InlineCompletion is insertText + the range it replaces; the range is
              // the caret, so the suggestion appends and Tab accepts it.
              resolve({
                items: [{
                  insertText: completion,
                  range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                }],
              });
            })
            .catch(() => {
              resolve({ items: [] });
            });
        }, DEBOUNCE_MS);
      });
    },
  };

  return monaco.languages.registerInlineCompletionsProvider("*", provider);
}
