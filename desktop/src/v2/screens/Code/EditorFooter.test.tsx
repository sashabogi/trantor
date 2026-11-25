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
  const setPosition = vi.fn();
  const reveal = vi.fn();
  const state = { line: 43, column: 9 };
  const editor: FooterEditor = {
    getModel: () => ({
      getOptions: () => ({ insertSpaces: init.spaces ?? true, tabSize: 2 }),
      getLanguageId: () => "typescript",
      getEOL: () => init.eol ?? "\n",
      getValueInRange: () => init.selection ?? "",
      getLineCount: () => 60,
    }),
    getPosition: () => ({ lineNumber: state.line, column: state.column }),
    getSelection: () => ({ isEmpty: () => !init.selection, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }),
    onDidChangeCursorPosition: on, onDidChangeCursorSelection: on, onDidChangeModel: on,
    onDidChangeModelOptions: on, onDidChangeModelLanguage: on,
    revealLineInCenter: reveal, setPosition, focus: () => {},
  };
  return { editor, listeners, disposed, setPosition, reveal, state };
}

describe("footerInfo", () => {
  it("reads position, selection, indentation and line ending", () => {
    const { editor } = fakeEditor({ eol: "\r\n", spaces: false, selection: "hello" });
    expect(footerInfo(editor)).toEqual({ line: 43, column: 9, selected: 5, language: "typescript", indent: "Tabs", eol: "CRLF" });
  });
});

describe("EditorFooter", () => {
  it("shows the position, follows the cursor, goes to a typed line and cleans up", () => {
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
    const box = host.querySelector("input");
    expect(box?.getAttribute("aria-label")).toBe("Go to line");
    if (box) box.value = "999";
    act(() => { box?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(fake.reveal).toHaveBeenCalledWith(60);
    expect(fake.setPosition).toHaveBeenCalledWith({ lineNumber: 60, column: 1 });
    expect(host.querySelector("input")).toBeNull();
    act(() => root.unmount());
    expect(fake.disposed).toHaveBeenCalledTimes(5);
  });
});
