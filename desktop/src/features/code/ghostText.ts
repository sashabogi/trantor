import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";
import { createGhostGate, type GhostRequest } from "./ghostGate";

// #5897 fast path: the Rust side now answers a completion with ONE direct HTTP call to a fast
// model (16-36s scrooge is gone), so the provider can stay live. Timing rules live in ghostGate.ts
// (pure, tested): 250ms debounce, in-flight fetch cancelled on the next keystroke.
const DEBOUNCE_MS = 250;
const LINES_BEFORE = 60;
const LINES_AFTER = 20;
const STORAGE_KEY = "code.ghostText";

function getEnabled(): boolean {
  try {
    // OFF until the operator turns it on — the toolbar switch remembers the choice in
    // localStorage, so this is read on every keystroke and flip is instant.
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

/** The completion, but only as far as the first line: Monaco paints an inline ghost on the cursor
 *  row, and a multi-line insertText would render as a block that jumps the layout. Tab accepts the
 *  first line; the model's reply is capped at 64 tokens and stops at a blank line anyway. */
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0];
  return line.trimEnd();
}

export function registerGhostTextProvider(_model: monaco.editor.ITextModel): monaco.IDisposable {
  // One gate per registration: the old module-level timer made two editors share a debounce.
  const gate = createGhostGate(DEBOUNCE_MS, (req: GhostRequest) => {
    // Tauri's invoke has no AbortSignal (options only carry headers), so the abort is the GATE's
    // epoch: a newer keystroke means this promise's answer is dropped before it is ever painted.
    return invoke<string>("ghost_complete", { prefix: req.prefix, suffix: req.suffix, path: req.path })
      .then((completion) => completion || null)
      .catch(() => null);
  });

  const provider: monaco.languages.InlineCompletionsProvider = {
    disposeInlineCompletions() {},
    provideInlineCompletions(model, position, _context, token) {
      if (!getEnabled()) return Promise.resolve({ items: [] });
      if (token.isCancellationRequested) return Promise.resolve({ items: [] });

      const { prefix, suffix } = extractContext(model, position);
      const path = model.uri.path;

      // The gate owns debounce + cancellation; Monaco's own token is the second abort path.
      return gate.schedule({ prefix, suffix, path }).then((completion) => {
        if (!completion || !completion.trim()) return { items: [] };
        if (token.isCancellationRequested) return { items: [] };
        const text = firstLine(completion);
        if (!text) return { items: [] };
        return {
          items: [{
            insertText: text,
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          }],
        };
      });
    },
  };

  return monaco.languages.registerInlineCompletionsProvider("*", provider);
}
