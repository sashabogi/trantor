// @vitest-environment happy-dom
// #13984 drill: the 2.0 composer takes files three ways (drop, paste, paperclip) and sends them the classic way.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { normalizeAttachments } from "../../features/chat/streaming";
import { Composer2 } from "./Composer2";
import { useAttachments } from "./useAttachments";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let sent: string[];
let calls: Array<{ cmd: string; args: unknown }>;
let saved: number;
const realFromPoint = document.elementFromPoint.bind(document);

// The adapter's own send formula (ComposerAdapter.send), so the encoding under test is the shipped one.
function Harness() {
  const [value, setValue] = useState("");
  const attachments = useAttachments();
  return (
    <Composer2 value={value} onChange={setValue} label="Message the orchestrator" agent="orchestrator"
      model={{ id: "claude-opus-5-5", label: "opus 5.5" }} contextPct={null}
      attachments={attachments}
      onSend={raw => { sent.push(normalizeAttachments(attachments.serialize(raw).trim())); setValue(""); attachments.clear(); }} />
  );
}

beforeEach(() => {
  sent = []; calls = []; saved = 0;
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "save_pasted_image") return `/Users/me/.agent-bus/attachments/pasted-${++saved}.png`;
    if (cmd === "attachment_info") return { bytes: 2048, thumb: "data:image/png;base64,AAAA" };
    return null;
  }, { shouldMockEvents: true });
  mockWindows("main");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); document.elementFromPoint = realFromPoint; });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
const chips = () => host.querySelectorAll("[data-chip]");

async function mount() {
  act(() => root.render(<Harness />));
  await flush();
}

async function dropOnComposer(paths: string[]) {
  const box = host.querySelector("textarea");
  document.elementFromPoint = () => box;
  await act(async () => { await emit("tauri://drag-drop", { paths, position: { x: 10, y: 10 } }); });
  await flush();
}

function imageFile(name: string) {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
}

describe("Composer2 attachments", () => {
  it("a drop on the composer adds a chip with a thumbnail and a labelled remove button", async () => {
    await mount();
    await dropOnComposer(["/Users/me/Desktop/shot one.png"]);
    expect(chips().length).toBe(1);
    expect(host.querySelector("[data-chip] img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    const remove = host.querySelector<HTMLButtonElement>('[data-chip] button[aria-label="Remove shot one.png"]');
    expect(remove?.title).toBe("Remove shot one.png");
    act(() => remove?.click());
    expect(chips().length).toBe(0);
  });

  it("a drop that lands outside the composer is ignored", async () => {
    await mount();
    document.elementFromPoint = () => document.body;
    await act(async () => { await emit("tauri://drag-drop", { paths: ["/Users/me/a.png"], position: { x: 1, y: 1 } }); });
    await flush();
    expect(chips().length).toBe(0);
  });

  it("pasting an image saves it through save_pasted_image and adds a chip", async () => {
    await mount();
    const ta = host.querySelector("textarea");
    const file = imageFile("clip.png");
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] } });
    await act(async () => { ta?.dispatchEvent(ev); });
    await flush();
    expect(ev.defaultPrevented).toBe(true);
    expect(calls.find(c => c.cmd === "save_pasted_image")?.args).toMatchObject({ kind: "image/png" });
    expect(chips().length).toBe(1);
  });

  it("the paperclip picker turns chosen images into chips", async () => {
    await mount();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    Object.defineProperty(input, "files", { value: [imageFile("a.png"), imageFile("b.png")], configurable: true });
    await act(async () => { input?.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(chips().length).toBe(2);
  });

  it("sends chips ahead of the words exactly like classic, and clears them", async () => {
    await mount();
    await dropOnComposer(["/Users/me/Desktop/one.png"]);
    const ta = host.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => { setter?.call(ta, "what is wrong here"); ta?.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click());
    expect(sent).toEqual(["/Users/me/Desktop/one.png what is wrong here"]);
    expect(chips().length).toBe(0);
    await dropOnComposer(["/Users/me/Desktop/a.png", "/Users/me/Desktop/b.png"]);
    act(() => { setter?.call(ta, "compare"); ta?.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click());
    expect(sent[1]).toBe("/Users/me/Desktop/a.png\n/Users/me/Desktop/b.png\ncompare");
  });

  it("chips alone are enough to send", async () => {
    await mount();
    await dropOnComposer(["/Users/me/Desktop/solo.png"]);
    const send = host.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    expect(send?.disabled).toBe(false);
    act(() => send?.click());
    expect(sent).toEqual(["/Users/me/Desktop/solo.png"]);
  });
});

describe("Composer2 without attachments", () => {
  it("keeps the paperclip disabled and renders no file input", () => {
    act(() => root.render(
      <Composer2 value="" onChange={vi.fn()} onSend={vi.fn()} label="m" agent="orchestrator" model={{ id: "x", label: "x" }}
        contextPct={null} />));
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Attach a file or image"]')?.disabled).toBe(true);
  });
});
