// @vitest-environment happy-dom
// #14073: the header controls, with a fake editor since Monaco does not run under happy-dom.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskControls, type AskSeat } from "./AskControls";
import type { AskEditor } from "./askContext";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const range = { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 6 };
const editor: AskEditor = { getSelection: () => range, getModel: () => ({ getValueInRange: () => "one\ntwo" }) };
const EXPECTED = "src/a.ts:3-4\n```\none\ntwo\n```";

let host: HTMLDivElement;
let root: Root;
const onAsk = vi.fn();
const onSendToSeat = vi.fn();

function Harness({ seats }: { seats: AskSeat[] }) {
  const [open, setOpen] = useState(false);
  return <AskControls getEditor={() => editor} path="src/a.ts" scope={null} seats={seats} menuOpen={open} onMenuOpen={setOpen} onAsk={onAsk} onSendToSeat={onSendToSeat} />;
}
const mount = (seats: AskSeat[]) => act(async () => { root.render(<Harness seats={seats} />); });
const byLabel = (l: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${l}"]`);
const click = (el: Element | null) => act(async () => { if (!(el instanceof HTMLElement)) throw new Error("not found"); el.click(); });

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); onAsk.mockClear(); onSendToSeat.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("AskControls (#14073)", () => {
  it("Ask sends the built context to onAsk", async () => {
    await mount([]);
    await click(byLabel("Ask about this"));
    expect(onAsk).toHaveBeenCalledWith(EXPECTED);
  });
  it("has no seat menu when no seat is live", async () => {
    await mount([]);
    expect(byLabel("Send to a seat")).toBeNull();
  });
  it("lists live seats by display name and sends to the picked one", async () => {
    await mount([{ seat: "kimi:kimi-9" }, { seat: "codex-2" }]);
    await click(byLabel("Send to a seat"));
    const items = [...host.querySelectorAll('[role="menuitem"]')];
    expect(items.map(i => i.textContent)).toEqual(["kimi-9", "codex-2"]);
    await click(items[0]);
    expect(onSendToSeat).toHaveBeenCalledWith("kimi:kimi-9", EXPECTED);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
});
