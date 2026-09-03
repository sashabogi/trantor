// @vitest-environment happy-dom
//
// The genesis sheet's two paths (#6120), proven against the REAL component: Blank is the default,
// a paste anywhere that is not a text input selects From a brief and fills it, and the create
// call carries a brief only on the brief path. The wake kickoff follows the path: BLANK_KICKOFF
// for Blank, the #6112 review wording for From a brief. The tauri surface arrives through the
// sheet's OWN deps seam (#6253) — a faithful in-memory invoke and a no-op drop channel — never a
// module mock.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { GenesisSheet } from "./GenesisSheet";
import { BLANK_KICKOFF } from "./genesisFlow";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: InvokeArgs }[] = [];
const invokeMock = <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
  calls.push({ cmd, args: args ?? {} });
  if (cmd === "project_new") {
    // SAFETY: the sheet dispatches project_new with the args object it builds at create; the fake
    // answers with the name that was asked for, the one field the sheet reads back from Rust.
    const asked = (args as { args: { name: string } }).args.name;
    // SAFETY: the sheet types this call Promise<string> of JSON — the envelope below is exactly
    // the project_new answer the sheet parses (dir/branch/hub/card), so it is a faithful T.
    return Promise.resolve(JSON.stringify({ name: asked, dir: "/tmp/x", branch: "main", hub: "http://h", card: null }) as T);
  }
  // SAFETY: the sheet's other calls read their answer as a JSON string it parses — "{}" is the
  // faithful empty envelope (the same answer Chat.test's invoke stub gives).
  return Promise.resolve("{}" as T);
};

// SAFETY: the drills pin the exact payloads the sheet dispatches — project_new carries the args
// object built at create, project_wake the flat kickoff string. These readers narrow the recorded
// InvokeArgs to the shape the sheet is being held to, once, instead of at every assertion.
const newPayload = (c: { cmd: string; args: InvokeArgs }) => c.args as { args: { name: string; brief: string } };
// SAFETY: project_wake's payload is the flat {project, kickoff} the sheet sends after create —
// this reader narrows the recorded InvokeArgs to that shape for the kickoff drills.
const wakeKickoff = (c: { cmd: string; args: InvokeArgs }) => (c.args as { kickoff: string }).kickoff;

let host: HTMLDivElement;
let root: Root;

const mount = async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GenesisSheet
        devRoot="/Users/s/development"
        onClose={() => {}}
        onMade={() => {}}
        onCreated={() => {}}
        deps={{ invoke: invokeMock, listenDrops: async () => () => {} }}
      />,
    );
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
    const name = host.querySelector<HTMLInputElement>("input")!;
    await typeInto(name, "pr-os");
    await submitForm();
    const fresh = calls.find(c => c.cmd === "project_new");
    expect(fresh).toBeTruthy();
    expect(newPayload(fresh!).args.brief).toBe("");
    const wake = calls.find(c => c.cmd === "project_wake");
    expect(wakeKickoff(wake!)).toBe(BLANK_KICKOFF);
  });

  it("a paste outside the inputs selects From a brief and fills it; the wake then convenes the review", async () => {
    await mount();
    const form = host.querySelector("form")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "Build a parser for X" } });
    await act(async () => { form.dispatchEvent(paste); });
    // the brief textarea exists now — the path switched
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe("Build a parser for X");
    expect(button("From a brief")?.getAttribute("aria-pressed")).toBe("true");

    const name = host.querySelector<HTMLInputElement>("input")!;
    await typeInto(name, "pr-os");
    await submitForm();
    const fresh = calls.find(c => c.cmd === "project_new");
    expect(newPayload(fresh!).args.brief).toBe("Build a parser for X");
    const wake = calls.find(c => c.cmd === "project_wake");
    const kickoff = wakeKickoff(wake!);
    expect(kickoff).toMatch(/docs\/PRD\.md/);
    expect(kickoff).toMatch(/prd-review/);
  });

  it("a paste INTO the name input still types a name — it never selects the brief path", async () => {
    await mount();
    const name = host.querySelector<HTMLInputElement>("input")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "pr-os" } });
    await act(async () => { name.dispatchEvent(paste); });
    expect(host.querySelector("textarea")).toBeNull();
  });
});
