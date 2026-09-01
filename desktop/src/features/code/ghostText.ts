import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";

const DEBOUNCE_MS = 300;
const LINES_BEFORE = 60;
const LINES_AFTER = 20;
const STORAGE_KEY = "code.ghostText";

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function getEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
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

function extractContext(model: monaco.editor.ITextModel, position: monaco.Position): { prefix: string; suffix: string } {
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
  model: monaco.editor.ITextModel,
): monaco.IDisposable {
  const provider: monaco.languages.InlineCompletionsProvider = {
    triggerCharacters: [],
    provideInlineCompletions(model, position, context, token) {
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
              const textEdits: monaco.editor.ISingleEditOperation[] = [{
                range: model.getFullModelRange(),
                text: completion,
                forceMoveMarkers: false,
              }];
              resolve({
                items: [{
                  insertText: completion,
                  filterText: completion,
                  sortText: completion,
                  textEdits,
                  details: "ghost text",
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
