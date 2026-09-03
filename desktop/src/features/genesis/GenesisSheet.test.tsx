// @vitest-environment happy-dom
//
// The genesis sheet's two paths (#6120), proven against the REAL component: Blank is the default,
// a paste anywhere that is not a text input selects From a brief and fills it, and the create
// call carries a brief only on the brief path. The wake kickoff follows the path: BLANK_KICKOFF
// for Blank, the #6112 review wording for From a brief. The Tauri surface is mocked at its two
// module boundaries (invoke + the drag-drop channel), since the component owns no try/catch
// around getCurrentWebview.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenesisSheet } from "./GenesisSheet";
import { BLANK_KICKOFF } from "./genesisFlow";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const invokeMock = (cmd: string, args?: Record<string, unknown>) => {
  calls.push({ cmd, args: args ?? {} });
  if (cmd === "project_new") {
    return Promise.resolve(JSON.stringify({ name: (args?.args as { name: string }).name, dir: "/tmp/x", branch: "main", hub: "http://h", card: null }));
  }
  return Promise.resolve("{}");
};

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

let host: HTMLDivElement;
let root: Root;

const mount = async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<GenesisSheet devRoot="/Users/s/development" onClose={() => {}} onMade={() => {}} onCreated={() => {}} />);
  });
};

beforeEach(() => { calls.length = 0; });
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (label: string) =>
  [...host.querySelectorAll("button")].find(b => b.textContent?.includes(label));

// SAFETY: React tracks value writes through the prototype setter; setting .value directly is
// deduped away. The native setter + a bubbling input event is the one write React always sees.
const typeInto = async (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const submitForm = async () => {
  const form = host.querySelector("form");
  if (!form) throw new Error("no form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};

describe("GenesisSheet two paths (#6120)", () => {
  it("defaults to Blank: no brief field, and the create carries NO brief", async () => {
    await mount();
    expect(button("From a brief")?.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector("textarea")).toBeNull();
    const name = host.querySelector("input") as HTMLInputElement;
    await typeInto(name, "pr-os");
    await submitForm();
    const fresh = calls.find(c => c.cmd === "project_new");
    expect(fresh).toBeTruthy();
    expect((fresh!.args.args as { brief: string }).brief).toBe("");
    const wake = calls.find(c => c.cmd === "project_wake");
    expect((wake!.args.kickoff as string)).toBe(BLANK_KICKOFF);
  });

  it("a paste outside the inputs selects From a brief and fills it; the wake then convenes the review", async () => {
    await mount();
    const form = host.querySelector("form")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "Build a parser for X" } });
    await act(async () => { form.dispatchEvent(paste); });
    // the brief textarea exists now — the path switched
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe("Build a parser for X");
    expect(button("From a brief")?.getAttribute("aria-pressed")).toBe("true");

    const name = host.querySelector("input") as HTMLInputElement;
    await typeInto(name, "pr-os");
    await submitForm();
    const fresh = calls.find(c => c.cmd === "project_new");
    expect((fresh!.args.args as { brief: string }).brief).toBe("Build a parser for X");
    const wake = calls.find(c => c.cmd === "project_wake");
    const kickoff = wake!.args.kickoff as string;
    expect(kickoff).toMatch(/docs\/PRD\.md/);
    expect(kickoff).toMatch(/prd-review/);
  });

  it("a paste INTO the name input still types a name — it never selects the brief path", async () => {
    await mount();
    const name = host.querySelector("input") as HTMLInputElement;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "pr-os" } });
    await act(async () => { name.dispatchEvent(paste); });
    expect(host.querySelector("textarea")).toBeNull();
  });
});
