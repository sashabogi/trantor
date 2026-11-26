// @vitest-environment happy-dom
// #14327: Chat hosted by the 2.0 shell draws the 2.0 transcript and one slim status line instead of the
// classic header, and nothing the classic header did is lost: the model, the status line, Hand off and its confirm.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { Chat, type ChatDeps } from "../../features/chat/Chat";
import type { Block, ToolResult, Turn } from "../../features/chat/streaming";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { cmd: string; args?: InvokeArgs };

const meta = (model: string) => ({ model, version: "", branch: "", context: { tokens: null, window: 0, frac: null } });

type Answered = string | string[] | null | { current: number; generation: number };
// SAFETY: Chat types each invoke by the command it sends and the fake answers that command's own shape.
const answer = <T,>(value: Answered): T => value as T;

/** An in-memory ChatDeps over a fixed transcript; the heavy children render nothing. */
function makeDeps(turns: Turn[], results: ToolResult[], opts: { model?: string; status?: string; pane?: boolean } = {}) {
  const calls: Call[] = [];
  const handlers = new Map<string, Array<(ev: { payload: unknown }) => void>>();
  const deps: ChatDeps = {
    invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
      calls.push({ cmd, args });
      if (cmd === "orchestrator_chat") return Promise.resolve(answer<T>(JSON.stringify([turns, results, turns.length, meta(opts.model ?? ""), []])));
      if (cmd === "chat_watch") return Promise.resolve(answer<T>({ current: turns.length, generation: 1 }));
      if (cmd === "orchestrator_status") return Promise.resolve(answer<T>(opts.status ?? "idle"));
      if (cmd === "wake_in_progress") return Promise.resolve(answer<T>([]));
      return Promise.resolve(answer<T>(null));
    },
    listen: <T,>(event: string, cb: (ev: { payload: T }) => void) => {
      // SAFETY: the container erases the payload type; each fire below sends exactly what Chat's own decode expects.
      handlers.set(event, [...(handlers.get(event) ?? []), cb as (ev: { payload: unknown }) => void]);
      return Promise.resolve(() => {});
    },
    orchestratorOf: async () => (opts.pane === false ? null : { project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
    answerAtSession: async () => {},
    Composer: () => null,
    TerminalPane: () => null,
  };
  return { deps, calls, handlers };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const mount = async (deps: ChatDeps, extra: Partial<Parameters<typeof Chat>[0]> = {}) => {
  await act(async () => { root.render(<Chat project="p" dock="pane" variant="v2" onDock={() => {}} onClose={() => {}} deps={deps} {...extra} />); });
  await flush();
};
const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === label) ?? null;
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const say = (t: string): Block => ({ kind: "text", text: t });

const talk: Turn[] = [
  { role: "user", blocks: [say("check the build")], ts: 1000 },
  { role: "assistant", blocks: [{ kind: "tool", tool: "Bash", text: "ls", tool_id: "t1", tool_kind: "command" }, say("It builds.")], ts: 2000 },
];

describe("Chat in the 2.0 shell", () => {
  it("renders the 2.0 transcript, not the classic bubbles, and no classic header or speaker labels", async () => {
    const { deps } = makeDeps(talk, [{ tool_id: "t1", ok: true, preview: "x" }], { model: "fable" });
    await mount(deps);
    expect(host.querySelector('[data-testid="transcript"]')).not.toBeNull();
    expect(host.textContent).toContain("check the build");
    expect(host.textContent).toContain("It builds.");
    expect(host.textContent).not.toContain("Orchestrator");
    expect(host.textContent?.toLowerCase()).not.toMatch(/\byou\b/);
    expect(host.querySelectorAll("header, [role=banner]")).toHaveLength(0);
  });

  it("keeps the classic rendering for the classic variant", async () => {
    const { deps } = makeDeps(talk, [{ tool_id: "t1", ok: true, preview: "x" }], { model: "fable" });
    await act(async () => { root.render(<Chat project="p" dock="pane" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    expect(host.querySelector('[data-testid="transcript"]')).toBeNull();
    expect(host.textContent).toContain("Orchestrator");
  });

  it("carries the model the session reported on the status line", async () => {
    const { deps } = makeDeps(talk, [], { model: "fable" });
    await mount(deps);
    const status = host.querySelector('[data-testid="chat-status"]');
    expect(status?.textContent).toContain("fable");
  });

  it("shows what the session is doing on the status line", async () => {
    const { deps } = makeDeps(talk, [], { status: "working" });
    await mount(deps);
    expect(host.querySelector('[data-testid="chat-status"]')?.textContent).toMatch(/working/i);
  });

  it("asks before handing off: Hand off, then Confirm handoff invokes handoff_now once with reason clicked", async () => {
    const { deps, calls } = makeDeps(talk, []);
    await mount(deps);
    expect(button("Confirm handoff")).toBeNull();
    await click(button("Hand off"));
    expect(button("Hand off")).toBeNull();
    expect(button("Cancel")).not.toBeNull();
    await click(button("Confirm handoff"));
    await flush();
    const sent = calls.filter(c => c.cmd === "handoff_now");
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toEqual({ project: "p", reason: "clicked" });
  });

  it("Cancel backs out of a handoff without sending anything", async () => {
    const { deps, calls } = makeDeps(talk, []);
    await mount(deps);
    await click(button("Hand off"));
    await click(button("Cancel"));
    expect(button("Hand off")).not.toBeNull();
    expect(calls.some(c => c.cmd === "handoff_now")).toBe(false);
  });

  it("disables Hand off, with the reason on hover, when no live agent is behind the pane", async () => {
    const { deps } = makeDeps(talk, [], { status: "none" });
    await mount(deps);
    const hand = button("Hand off");
    expect(hand?.hasAttribute("disabled")).toBe(true);
    expect(hand?.getAttribute("title")).toContain("no orchestrator session is behind this pane");
  });

  it("offers no Hand off without a hosted pane, and no Hand off in a past session, where Back returns", async () => {
    const none = makeDeps(talk, [], { pane: false });
    await mount(none.deps);
    expect(button("Hand off")).toBeNull();
    let closed = 0;
    const past = makeDeps(talk, []);
    await mount(past.deps, { sessionId: "sess-1", onClose: () => { closed++; } });
    expect(button("Hand off")).toBeNull();
    expect(host.querySelector('[data-testid="chat-status"]')?.textContent).toContain("Claude session sess-1");
    await click(button("Back"));
    expect(closed).toBe(1);
  });
});

describe("the Latest pill in the 2.0 shell", () => {
  const rows = (after: number, n: number) => JSON.stringify({
    project: "p", sessionId: "s1", after, total: after + n, results: [], meta: meta(""),
    turns: Array.from({ length: n }, (_, i) => ({ role: "assistant", blocks: [say(`line ${after + i}`)] })),
  });
  const scroller = () => {
    const el = host.querySelector<HTMLDivElement>(".overflow-y-auto");
    if (!el) throw new Error("transcript scroller missing");
    return el;
  };
  const pill = () => host.querySelector<HTMLButtonElement>('[data-testid="latest-pill"]');

  it("replaces the round button: hidden at the foot, Latest when scrolled up, N new as turns land, gone after a click", async () => {
    const scrolls = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      const { deps, handlers } = makeDeps([], []);
      await mount(deps);
      expect(pill()).toBeNull();
      const el = scroller();
      Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
      el.scrollTop = 100;
      await act(async () => { el.dispatchEvent(new Event("scroll")); });
      expect(pill()?.textContent).toBe("Latest");
      expect(host.querySelector('button[aria-label="Jump to latest"]')).toBe(pill());
      await act(async () => { for (const cb of handlers.get("chat-rows") ?? []) cb({ payload: rows(0, 2) }); });
      await flush();
      expect(pill()?.textContent).toBe("2 new");
      expect(pill()?.getAttribute("aria-label")).toContain("new messages below");
      await click(pill());
      expect(pill()).toBeNull();
    } finally {
      scrolls.mockRestore();
    }
  });
});
