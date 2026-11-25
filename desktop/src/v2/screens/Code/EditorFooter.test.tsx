// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { EditorFooter, footerInfo, type FooterEditor } from "./EditorFooter";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Listener = () => void;
function fakeEditor(init: { eol?: string; spaces?: boolean; selection?: string }) {
  const listeners: Listener[] = [];
  const disposed = vi.fn();
  const on = (cb: Listener) => { listeners.push(cb); return { dispose: disposed }; };
  const run = vi.fn(() => Promise.resolve());
  const state = { line: 43, column: 9 };
  const editor: FooterEditor = {
    getModel: () => ({
      getOptions: () => ({ insertSpaces: init.spaces ?? true, tabSize: 2 }),
      getLanguageId: () => "typescript",
      getEOL: () => init.eol ?? "\n",
      getValueInRange: () => init.selection ?? "",
    }),
    getPosition: () => ({ lineNumber: state.line, column: state.column }),
    getSelection: () => ({ isEmpty: () => !init.selection, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }),
    onDidChangeCursorPosition: on, onDidChangeCursorSelection: on, onDidChangeModel: on,
    onDidChangeModelOptions: on, onDidChangeModelLanguage: on,
    getAction: () => ({ run }), focus: () => {},
  };
  return { editor, listeners, disposed, run, state };
}

describe("footerInfo", () => {
  it("reads position, selection, indentation and line ending", () => {
    const { editor } = fakeEditor({ eol: "\r\n", spaces: false, selection: "hello" });
    expect(footerInfo(editor)).toEqual({ line: 43, column: 9, selected: 5, language: "typescript", indent: "Tabs", eol: "CRLF" });
  });
});

describe("EditorFooter", () => {
  it("shows the position, follows the cursor, opens go to line and cleans up", () => {
    const fake = fakeEditor({ selection: "abcde" });
    const ref = { current: fake.editor };
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<EditorFooter editorRef={ref} version={1} />));
    expect(host.textContent).toContain("Ln 43, Col 9 (5 selected)");
    expect(host.textContent).toContain("Spaces: 2");
    expect(host.textContent).toContain("LF");
    expect(host.textContent).toContain("TypeScript");
    fake.state.line = 50;
    act(() => fake.listeners[0]());
    expect(host.textContent).toContain("Ln 50, Col 9");
    act(() => host.querySelector("button")?.click());
    expect(fake.run).toHaveBeenCalled();
    act(() => root.unmount());
    expect(fake.disposed).toHaveBeenCalledTimes(5);
  });
});
