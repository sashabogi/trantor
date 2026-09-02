// The document sync's contract (#5857): the params shapes on the wire, the crate-prefix client
// picking, the completion mapping, and the track → didOpen → didChange → didClose lifecycle —
// all against fakes, no monaco, no Tauri.
import { describe, expect, it } from "vitest";
import {
  attachOpenDocuments,
  completionParams,
  didChangeParams,
  didCloseParams,
  didOpenParams,
  lspCompletion,
  pickClient,
  setDocClientRows,
  toMonacoSuggestions,
  trackDocument,
  type DocClient,
  type DocClientRow,
  type DocNotifyParams,
  type CompletionRequest,
  type LspCompletionResponse,
  type ModelChange,
  type SyncModel,
} from "./lspDocuments";

type Note =
  | { method: "textDocument/didOpen"; params: ReturnType<typeof didOpenParams> }
  | { method: "textDocument/didChange"; params: ReturnType<typeof didChangeParams> }
  | { method: "textDocument/didClose"; params: ReturnType<typeof didCloseParams> }
  | { method: string; params: DocNotifyParams };

function fakeClient(): DocClient & { notes: Note[] } {
  return {
    notes: [],
    async sendNotification(method: string, params: DocNotifyParams) {
      // SAFETY: the sync only ever sends the three did* methods with the exact params builders
      // above, so recording method+params here is a faithful in-memory bus for the assertions.
      this.notes.push({ method, params } as Note);
    },
    async sendRequest(_method: string, _params: CompletionRequest): Promise<LspCompletionResponse> {
      return { items: [] };
    },
  };
}

/** A SyncModel stand-in with real event wiring. */
function fakeModel(uri: string, text: string) {
  const changeCbs: Array<(e: { changes: ModelChange[] }) => void> = [];
  const disposeCbs: Array<() => void> = [];
  // SAFETY: the object below IS a SyncModel by construction (same method surface) with the two
  // extra fields the fake's edit()/assertions read; the assertion only widens it by those.
  const model = {
    uri,
    value: text,
    version: 1,
    getValue() { return this.value; },
    getVersionId() { return this.version; },
    onDidChangeContent(cb: (e: { changes: ModelChange[] }) => void) {
      changeCbs.push(cb);
      return { dispose() {} };
    },
    onWillDispose(cb: () => void) { disposeCbs.push(cb); },
  } as SyncModel & { value: string; version: number };
  return {
    model,
    edit(text: string) {
      this.model.version += 1;
      this.model.value += text;
      for (const cb of changeCbs) cb({
        changes: [{
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
          text,
        }],
      });
    },
    dispose() { for (const cb of disposeCbs) cb(); },
  };
}

const URI = "file:///repo/crate/src/lib.rs";

describe("protocol shapes", () => {
  it("didOpen carries uri, language, version and full text", () => {
    expect(didOpenParams(URI, "rust", 3, "fn main() {}")).toEqual({
      textDocument: { uri: URI, languageId: "rust", version: 3, text: "fn main() {}" },
    });
  });

  it("didChange converts monaco's 1-based ranges to LSP's 0-based", () => {
    expect(didChangeParams(URI, 4, [{
      range: { startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 9 },
      text: "std::",
    }])).toEqual({
      textDocument: { uri: URI, version: 4 },
      contentChanges: [{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 8 } }, text: "std::" }],
    });
  });

  it("didClose carries just the uri", () => {
    expect(didCloseParams(URI)).toEqual({ textDocument: { uri: URI } });
  });

  it("completion positions are 0-based", () => {
    expect(completionParams(URI, 10, 7)).toEqual({
      textDocument: { uri: URI },
      position: { line: 9, character: 6 },
    });
  });
});

describe("pickClient", () => {
  const a = fakeClient();
  const b = fakeClient();
  const rows: DocClientRow[] = [
    { workspaceRoot: "/repo", language: "rust", client: a },
    { workspaceRoot: "/repo/crate", language: "rust", client: b },
    { workspaceRoot: "/repo", language: "python", client: fakeClient() },
  ];

  it("picks the LONGEST workspace-root prefix (the nested crate, not the checkout)", () => {
    expect(pickClient(rows, URI, "rust")).toBe(b);
  });

  it("matches the language", () => {
    expect(pickClient(rows, URI, "python")).not.toBe(b);
  });

  it("a file outside every served root gets no client", () => {
    expect(pickClient(rows, "file:///elsewhere/x.rs", "rust")).toBeNull();
  });

  it("a non-file URI gets no client", () => {
    expect(pickClient(rows, "inmemory://model/1", "rust")).toBeNull();
  });

  it("a root boundary must be a real path boundary (/repo2 is not under /repo)", () => {
    expect(pickClient(rows, "file:///repo2/x.rs", "rust")).toBeNull();
  });
});

describe("completion mapping", () => {
  const kinds = { Method: 0, Function: 1, Text: 18, Keyword: 17, insertAsSnippetRule: 4 };
  const word = { startLineNumber: 3, startColumn: 8, endLineNumber: 3, endColumn: 12 };

  it("maps an { items } response, applying the word range when the item has no textEdit", () => {
    const out = toMonacoSuggestions({ items: [{ label: "collections", kind: 9, detail: "std::collections" }] }, word, kinds);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("collections");
    expect(out[0].insertText).toBe("collections");
    expect(out[0].range).toEqual(word);
    expect(out[0].sortText).toBe("collections");
  });

  it("maps a bare array response and converts textEdit ranges to 1-based", () => {
    const out = toMonacoSuggestions([{
      label: "io",
      textEdit: { newText: "std::io", range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } } },
    }], word, kinds);
    expect(out[0].insertText).toBe("std::io");
    expect(out[0].range).toEqual({ startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 9 });
  });

  it("maps kinds by name and marks snippets", () => {
    const out = toMonacoSuggestions([{ label: "fn", kind: 14, insertTextFormat: 2 }], word, kinds);
    expect(out[0].kind).toBe(17);
    expect(out[0].insertTextRules).toBe(4);
  });

  it("an empty/absent response maps to no suggestions", () => {
    expect(toMonacoSuggestions([], word, kinds)).toEqual([]);
    expect(toMonacoSuggestions({ items: undefined }, word, kinds)).toEqual([]);
  });
});

describe("document sync lifecycle", () => {
  it("didOpen waits for a client, rides notify, forwards edits, closes on model dispose", async () => {
    const client = fakeClient();
    const doc = fakeModel(URI, "fn main() {}\n");

    setDocClientRows(() => []); // no client yet: track must NOT send didOpen
    trackDocument(doc.model, "rust");
    expect(client.notes).toEqual([]);

    setDocClientRows(() => [{ workspaceRoot: "/repo/crate", language: "rust", client }]);
    attachOpenDocuments();
    expect(client.notes.map(n => n.method)).toEqual(["textDocument/didOpen"]);
    // SAFETY: notes[0].method was just asserted "textDocument/didOpen", so this narrowing to the
    // didOpen params shape is exact — the assertion above is the guard.
    const open = client.notes[0] as { method: "textDocument/didOpen"; params: ReturnType<typeof didOpenParams> };
    expect(open.params.textDocument.text).toBe("fn main() {}\n");

    doc.edit("use std::io;\n");
    expect(client.notes.map(n => n.method)).toEqual(["textDocument/didOpen", "textDocument/didChange"]);
    // SAFETY: notes[1].method was just asserted "textDocument/didChange", so the narrowing to the
    // didChange params shape is exact — the assertion above is the guard.
    const change = client.notes[1] as { method: "textDocument/didChange"; params: ReturnType<typeof didChangeParams> };
    expect(change.params.textDocument.version).toBe(2);

    doc.dispose();
    expect(client.notes.map(n => n.method)).toEqual([
      "textDocument/didOpen", "textDocument/didChange", "textDocument/didClose",
    ]);
    setDocClientRows(() => []);
  });

  it("tracking the same URI twice does not double didOpen", () => {
    const client = fakeClient();
    setDocClientRows(() => [{ workspaceRoot: "/repo/crate", language: "rust", client }]);
    const doc = fakeModel(URI, "x");
    trackDocument(doc.model, "rust");
    trackDocument(doc.model, "rust");
    expect(client.notes.map(n => n.method)).toEqual(["textDocument/didOpen"]);
    doc.dispose();
    setDocClientRows(() => []);
  });

  it("a respawned client re-opens the document", () => {
    const first = fakeClient();
    const second = fakeClient();
    let current = first;
    setDocClientRows(() => [{ workspaceRoot: "/repo/crate", language: "rust", client: current }]);
    const doc = fakeModel(URI, "x");
    trackDocument(doc.model, "rust");
    expect(first.notes.map(n => n.method)).toEqual(["textDocument/didOpen"]);

    current = second; // the respawn: same root, new client
    attachOpenDocuments();
    expect(second.notes.map(n => n.method)).toEqual(["textDocument/didOpen"]);
    doc.dispose();
    setDocClientRows(() => []);
  });

  it("lspCompletion asks the owning client and returns null with none", async () => {
    const client = fakeClient();
    setDocClientRows(() => [{ workspaceRoot: "/repo/crate", language: "rust", client }]);
    const result = await lspCompletion(URI, "rust", 5, 10);
    expect(result).toEqual({ items: [] });

    setDocClientRows(() => []);
    expect(await lspCompletion(URI, "rust", 5, 10)).toBeNull();
  });
});
