// @vitest-environment happy-dom
// #14494: the Code chat rail shows the conversation — the orchestrator's reply arrives in the rail
// itself, read from the same transcript source the Workspace chat column uses, not in the Workspace.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient, type Peer } from "../../../shared/api/client";
import { ChatRail, isOrchestrator, pickTarget } from "./ChatRail";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now();
const META = { model: "glm-5.3", version: "", branch: "main", context: { tokens: null, window: 0, frac: null } };
const PROMPT = { role: "user", blocks: [{ kind: "text", text: "why is the diff blank?" }], ts: 1_000 };
const REPLY = { role: "assistant", blocks: [{ kind: "text", text: "The webview lost focus; here is the fix." }], ts: 30_000 };
const ORCH: Peer = { session: "MacBook-Pro-M1:trantor", project: "trantor", status: "idle", lastSeen: now, online: true, model: "claude" };
const KIMI: Peer = { session: "kimi-9:trantor", project: "trantor", status: "working · card", lastSeen: now, online: true, model: "kimi" };

/** 0 = only the prompt has landed, 1 = the reply has landed too. Flipped mid-test to model arrival. */
let phase = 0;
const reads: number[] = [];
const sends: { to: string; text: string }[] = [];
const client = new HubClient("http://hub.test", async ({ method, path, body }) => {
  if (method === "POST" && path === "/send") {
    // SAFETY: our own test transport's body, built one line above by client.send.
    const p = JSON.parse(body ?? "{}") as { to: string; text: string };
    sends.push(p);
    return { status: 200, body: JSON.stringify({ ok: true, id: 1 }) };
  }
  return { status: 200, body: "{}" };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  phase = 0;
  reads.length = 0;
  sends.length = 0;
  mockIPC((command, args) => {
    if (command === "machine_id") return "MacBook-Pro-M1";
    if (command !== "orchestrator_chat") return null;
    // SAFETY: mockIPC hands back the args our own invoke built; after is the cursor we passed in.
    const after = (args as { after: number }).after;
    reads.push(after);
    const turns = after === 0 ? (phase === 0 ? [PROMPT] : [PROMPT, REPLY]) : phase === 0 ? [] : [REPLY];
    return JSON.stringify([turns, [], phase === 0 ? 1 : 2, META, []]);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mount = async (over: Partial<Parameters<typeof ChatRail>[0]> = {}) => {
  await act(async () => {
    root.render(<ChatRail client={client} project="trantor" peers={[ORCH, KIMI]} open onToggle={() => {}}
      draft={over.draft ?? ""} onDraft={() => {}} want={over.want ?? null} />);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

describe("pickTarget", () => {
  it("talks to the orchestrator by default and to the named seat when one is wanted", () => {
    expect(pickTarget([ORCH, KIMI], "trantor", null, "MacBook-Pro-M1")?.session).toBe("MacBook-Pro-M1:trantor");
    expect(pickTarget([ORCH, KIMI], "trantor", "kimi-9")?.session).toBe("kimi-9:trantor");
    expect(pickTarget(null, "trantor", null)).toBeNull();
    expect(isOrchestrator(ORCH, "MacBook-Pro-M1")).toBe(true);
    expect(isOrchestrator(KIMI)).toBe(false);
  });
});

describe("ChatRail conversation", () => {
  it("draws the orchestrator conversation from the chat's own transcript source", async () => {
    phase = 1;
    await mount();
    expect(host.querySelector('[role="log"] [data-testid="transcript"]')).not.toBeNull();
    expect(host.querySelector("[data-prompt-id]")?.textContent).toBe("why is the diff blank?");
    expect(host.textContent).toContain("The webview lost focus; here is the fix.");
    expect(reads[0]).toBe(0);
  });

  it("caps the tail at the last turns and says how much sits above", async () => {
    phase = 1;
    const many = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", blocks: [{ kind: "text", text: `line ${i}` }] }));
    mockIPC(command => {
      if (command !== "orchestrator_chat") return null;
      return JSON.stringify([many, [], 60, META, []]);
    });
    await mount();
    expect(host.textContent).toContain("20 older turns above");
    expect(host.textContent).toContain("line 59");
    expect(host.textContent).not.toContain("line 19");
  });

  it("a reply that lands while the rail idles shows up on its own", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<ChatRail client={client} project="trantor" peers={[ORCH]} open onToggle={() => {}} draft="" onDraft={() => {}} want={null} />);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).not.toContain("webview lost focus");
    phase = 1;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(host.textContent).toContain("The webview lost focus; here is the fix.");
  });

  it("sending looks for the answer right away and the reply arrives without leaving Code", async () => {
    await mount({ draft: "please fix the diff" });
    expect(host.textContent).not.toContain("webview lost focus");
    phase = 1; // the orchestrator's reply has landed in the transcript
    await click(host.querySelector('button[aria-label="Send"]'));
    await flush();
    expect(sends[0]).toMatchObject({ to: "MacBook-Pro-M1:trantor", text: "please fix the diff" });
    expect(host.textContent).toContain("The webview lost focus; here is the fix.");
    expect(host.textContent).not.toContain("replies land in the Workspace");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("reply appears here");
  });

  it("a crew seat target has no transcript here, and the send note stays honest about it", async () => {
    await mount({ want: "kimi-9", draft: "status?" });
    expect(host.querySelector('[data-testid="transcript"]')).toBeNull();
    expect(reads).toEqual([]);
    await click(host.querySelector('button[aria-label="Send"]'));
    await flush();
    expect(sends[0]).toMatchObject({ to: "kimi-9:trantor", text: "status?" });
    expect(host.textContent).toContain("Its replies land in the Workspace.");
  });

  it("reads no transcript while folded — the rail stays cheap until it is opened", async () => {
    await act(async () => {
      root.render(<ChatRail client={client} project="trantor" peers={[ORCH]} open={false} onToggle={() => {}} draft="" onDraft={() => {}} want={null} />);
    });
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(reads).toEqual([]);
    expect(host.querySelector('[aria-label="Chat, folded"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Open the chat"]')).not.toBeNull();
  });
});
