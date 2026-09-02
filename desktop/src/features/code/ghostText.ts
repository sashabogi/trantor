import { Channel, invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";
import { createGhostGate, splitPrefix, type GhostFetcher, type GhostRequest } from "./ghostGate";

// #5897 fast path, made live by #6160: the Rust side now opens ONE `stream: true` call to the fast
// model and forwards deltas on a request-keyed channel; the invoke resolves the moment the FIRST
// LINE is complete (or ~32 tokens), and the rest of the HTTP stream is aborted. Timing rules stay
// in ghostGate.ts (pure, tested): 250ms debounce, in-flight fetch cancelled on the next keystroke —
// the cancellation now also reaches Rust (ghost_cancel), so a superseded request stops generating.
// The 2s ceiling is time-to-first-line, not the whole response.
const DEBOUNCE_MS = 250;
const LINES_BEFORE = 60;
const LINES_AFTER = 20;
const STORAGE_KEY = "code.ghostText";

let ghostSeq = 0;

/** One streaming event from ghost.rs, keyed by the request id this module generated. */
type GhostStreamEvent =
  | { kind: "delta"; id: string; text: string }
  | { kind: "done"; id: string; text: string; ttl_ms: number; reason: string };

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
 *  first line; the model's reply is capped at 32 tokens and stops at a blank line anyway. */
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0];
  return line.trimEnd();
}

export function registerGhostTextProvider(_model: monaco.editor.ITextModel): monaco.IDisposable {
  // One gate per registration: the old module-level timer made two editors share a debounce.
  const fetcher: GhostFetcher = (req: GhostRequest, signal: AbortSignal) => {
    const id = `ghost-${++ghostSeq}`;
    const { head, near } = splitPrefix(req.prefix);
    // Deltas stream in here as they land; the ghost itself paints when the invoke resolves, which
    // Rust does the moment the first line is complete (#6160) — no partial paint.
    const onEvent = new Channel<GhostStreamEvent>(() => {});
    // Real cancel-on-keystroke: the gate aborts its controller on a newer keystroke; tell Rust to
    // stop spending tokens on the superseded completion. Best-effort — invoke can reject when the
    // command is unknown or the window is closing, and a missed cancel only wastes tokens.
    signal.addEventListener("abort", () => {
      invoke("ghost_cancel", { id }).catch(() => {});
    });
    return invoke<string>("ghost_complete_stream", {
      id, head, near, suffix: req.suffix, path: req.path, onEvent,
    })
      .then((completion) => completion || null)
      .catch(() => null);
  };
  const gate = createGhostGate(DEBOUNCE_MS, fetcher);

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
