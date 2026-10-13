// @vitest-environment happy-dom
//
// #11665: the composer's draft is per project. The component drills run the real Composer with the
// Tauri IPC replaced by an in-memory disk, so persistence is mocked and nothing real is touched.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { makeChip } from "./attachments";
import { canSendDraft, composerDraftApi, draftSlots, emptyDraft, flushSaves, fromStored, scheduleSave, toStored } from "./composerDraft";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The mocked IPC: `disk` stands in for config.json's composerDrafts map, `sent` records pane_send.
let disk: Map<string, string>;
let sent: { target: string | null; text: string }[];
const w = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<string> } };
w.__TAURI_INTERNALS__ = {
  invoke: (cmd, args = {}) => {
    if (cmd === "composer_draft_get") return Promise.resolve(disk.get(String(args.project)) ?? "null");
    if (cmd === "composer_draft_set") {
      const draft = String(args.draft);
      if (draft === "null") disk.delete(String(args.project)); else disk.set(String(args.project), draft);
      return Promise.resolve("");
    }
    if (cmd === "pane_send") { sent.push({ target: args.target as string | null, text: String(args.text) }); return Promise.resolve(""); }
    return Promise.resolve("{}");
  },
};

const stubGlobal = globalThis as { localStorage?: Storage };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  disk = new Map();
  sent = [];
  draftSlots.reset();
  const mem = new Map<string, string>();
  stubGlobal.localStorage = {
    getItem: k => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: k => void mem.delete(k),
    clear: () => mem.clear(), key: () => null, length: 0,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const show = (project: string) => act(() => root.render(
  <Composer
    project={project}
    target={`${project}-pane`}
    live
    liveWhy=""
    model="opus"
    modelSource="reported"
    working={false}
    userTexts={[]}
    context={{ tokens: null, window: 200000, frac: null }}
    fontStep="m"
    onFontStep={() => {}}
    onSent={() => {}}
    onLongRunChange={() => {}}
    onDispatch={() => {}}
  />,
));

const box = () => host.querySelector("textarea") as HTMLTextAreaElement;
const type = (text: string) => act(() => {
  // SAFETY: React tracks the value through the prototype setter; assigning on the element would be swallowed.
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  set?.call(box(), text);
  box().dispatchEvent(new Event("input", { bubbles: true }));
});
const enter = () => act(() => { box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("the composer draft is per project (#11665)", () => {
  it("switching projects carries nothing: the other project opens with an empty box", () => {
    show("a");
    type("words for a");
    expect(box().value).toBe("words for a");
    show("b");
    expect(box().value).toBe("");
    enter();
    expect(sent).toEqual([]);
  });

  it("switching back restores that project's own draft, chips included", () => {
    show("a");
    type("words for a");
    // The same slot the drop/paste doors fill: a chip for project a.
    act(() => draftSlots.put({ project: "a", text: "words for a", chips: [makeChip("c1", "/x/shot.png", 5)] }));
    show("b");
    type("words for b");
    show("a");
    expect(box().value).not.toBe("words for b");
    show("b");
    expect(box().value).toBe("words for b");
    show("a");
    expect(draftSlots.get("a")?.text).toBe("words for a");
  });

  it("a send reaches only the project the draft was written in, and clears only that slot", () => {
    show("a");
    type("for a");
    show("b");
    type("for b");
    enter();
    expect(sent).toEqual([{ target: "b-pane", text: "for b" }]);
    expect(box().value).toBe("");
    show("a");
    expect(box().value).toBe("for a");
    expect(draftSlots.get("b")?.text).toBe("");
  });

  it("a draft stamped for another project is refused", () => {
    expect(canSendDraft({ project: "a", text: "x", chips: [] }, "a")).toBe(true);
    expect(canSendDraft({ project: "a", text: "x", chips: [] }, "b")).toBe(false);
    expect(canSendDraft(emptyDraft("b"), "b")).toBe(true);
  });

  it("a restart restores the draft from disk: text and attachment paths", async () => {
    show("a");
    type("typed before quit");
    flushSaves();
    await settle();
    expect(disk.get("a")).toBeTruthy();

    // Relaunch: every in-memory slot is gone, only the disk map remains.
    act(() => root.unmount());
    draftSlots.reset();
    root = createRoot(host);
    show("a");
    await settle();
    expect(box().value).toBe("typed before quit");
    // Another project does not see it.
    show("b");
    await settle();
    expect(box().value).toBe("");
    // A project whose disk row carries an attachment path gets the chip back.
    disk.set("c", JSON.stringify({ text: "", chips: [{ path: "/x/shot.png", size: 5 }] }));
    show("c");
    await settle();
    expect(draftSlots.get("c")?.chips.map(c => c.path)).toEqual(["/x/shot.png"]);
  });

  it("sending clears the persisted row too", async () => {
    show("a");
    type("will send");
    enter();
    flushSaves();
    await settle();
    expect(disk.has("a")).toBe(false);
  });
});

describe("draft storage shape", () => {
  it("round-trips text and chip paths, drops chips without a path, and treats junk as no draft", async () => {
    const d = { project: "p", text: "hi", chips: [makeChip("c1", "/a/b.png", 3)] };
    const back = fromStored("p", toStored(d));
    expect(back?.text).toBe("hi");
    expect(back?.chips.map(c => [c.path, c.size, c.kind])).toEqual([["/a/b.png", 3, "image"]]);
    expect(fromStored("p", { text: "t", chips: [{ size: 2 }, { path: "" }] })?.chips).toEqual([]);
    expect(fromStored("p", {})).toBeNull();
    expect(fromStored("p", null)).toBeNull();
    expect(toStored(emptyDraft("p"))).toBeNull();
    const bad = vi.fn().mockResolvedValue("{not json");
    expect(await composerDraftApi.get("p", bad as never)).toBeNull();
  });

  it("debounces saves per project and flush writes the latest immediately", async () => {
    vi.useFakeTimers();
    const calls: unknown[] = [];
    const inv = ((cmd: string, args: unknown) => { calls.push([cmd, args]); return Promise.resolve(""); }) as never;
    scheduleSave({ project: "p", text: "a", chips: [] }, inv, 400);
    scheduleSave({ project: "p", text: "ab", chips: [] }, inv, 400);
    expect(calls).toHaveLength(0);
    flushSaves(inv);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain("ab");
    vi.useRealTimers();
  });
});
