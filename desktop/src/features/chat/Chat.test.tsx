// @vitest-environment happy-dom
// #5993: the working gate's belt. The pushed status stream can freeze on `working`, so the chat
// re-seeds ONCE per `turn_ended` batch and per `chat-session-changed`. The tauri/herdr seams are
// INJECTED through ChatDeps; assertions count `orchestrator_status` invokes.
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { Chat, type ChatDeps } from "./Chat";
import type { HerdrSeat } from "../workspace/herdr";
import { WAKE_OUTCOME_MS } from "../genesis/wakeRow";
import type { WakeProgress } from "../genesis/wakeProgress";
import type { AskQuestion } from "./streaming";
import { HANDOFF_COUNTDOWN_MS } from "./banner";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Invoked = { cmd: string };
// The container holds handlers for BOTH payload shapes the chat listens to: chat-rows /
// chat-session-changed / orch-status arrive as JSON strings, wake-progress as a structured
// object. `unknown` is the honest payload type — the fires narrow it, never a cast.
type Handler = (ev: { payload: unknown }) => void;
type AskEventPayload = {
  project: string; session_id: string; tool_use_id: string | null; open: boolean;
  visible: boolean; questions: AskQuestion[];
};

/** A faithful in-memory ChatDeps: invoke answers the chat's commands, listen records handlers,
 *  orchestratorOf finds no pane, and the heavy children render nothing. */
function makeDeps(wakeProjects: string[] = []) {
  const invokes: Invoked[] = [];
  const handlers = new Map<string, Handler[]>();
  const deps: ChatDeps = {
    invoke: <T,>(cmd: string): Promise<T> => {
      invokes.push({ cmd });
      if (cmd === "wake_in_progress") {
        // SAFETY: Chat types this call Promise<string[]> — the projects holding a wake chain.
        return Promise.resolve(wakeProjects as T);
      }
      if (cmd === "orchestrator_chat") {
        // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is exactly
        // the Backfill shape (empty turns, cursor 0), so the parse yields an empty thread.
        return Promise.resolve(JSON.stringify([[], [], 0,
          { model: "", version: "", branch: "", context: { tokens: null, window: 0, frac: null } }, []]) as T);
      }
      if (cmd === "chat_watch") {
        // SAFETY: Chat types this call Promise<ChatWatchResult> — the row count the watcher
        // started at, plus the generation token #6113 added for chat_unwatch to echo back.
        return Promise.resolve({ current: 0, generation: 1 } as T);
      }
      if (cmd === "orchestrator_status") {
        // SAFETY: Chat types this call Promise<string> and treats the value as herdr's status text.
        return Promise.resolve("idle" as T);
      }
      // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
      return Promise.resolve(null as T);
    },
    listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
      // SAFETY: the handler is stored under the unknown-payload container (Handler, above) and
      // fired with exactly what listen delivered — the container erases nothing the fires need.
      const boxed = cb as Handler;
      handlers.set(event, [...(handlers.get(event) ?? []), boxed]);
      return Promise.resolve(() => {});
    },
    orchestratorOf: async () => {
      // SAFETY: the test mounts no herdr pane, so the seam reports no orchestrator surface (null) —
      // exactly what Chat treats as "not hosted".
      return null as HerdrSeat | null;
    },
    answerAtSession: async () => {},
    Composer: () => null,
    TerminalPane: () => null,
  };
  return { deps, invokes, handlers };
}

const META = { model: "", version: "", branch: "", context: { tokens: null, window: 0, frac: null } };

function rowsPayload(extra: Partial<{ project: string; sessionId: string; after: number; total: number; turn_ended: boolean }> = {}): string {
  return JSON.stringify({
    project: "p", sessionId: "s1", after: 0, total: 0, turns: [], results: [], meta: META,
    ...extra,
  });
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

describe("Chat status re-seed (#5993)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let invokes: Invoked[];
  let handlers: Map<string, Handler[]>;

  const statusSeeds = () => invokes.filter(c => c.cmd === "orchestrator_status").length;
  const fire = (event: string, payload: string) =>
    act(async () => { for (const cb of handlers.get(event) ?? []) cb({ payload }); });

  const render = (extra: Partial<Parameters<typeof Chat>[0]> = {}) => {
    const d = makeDeps();
    invokes = d.invokes;
    handlers = d.handlers;
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={d.deps} {...extra} />); });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("re-seeds once on a turn_ended batch, and never without one", async () => {
    render();
    await flush();
    await flush();
    expect(handlers.has("chat-rows")).toBe(true);
    const baseline = statusSeeds(); // the mount seed

    // A batch WITHOUT turn_ended never re-seeds.
    await fire("chat-rows", rowsPayload({ after: 0, total: 1 }));
    await flush();
    expect(statusSeeds()).toBe(baseline);

    // The turn-ended batch re-seeds EXACTLY once.
    await fire("chat-rows", rowsPayload({ after: 1, total: 2, turn_ended: true }));
    await flush();
    expect(statusSeeds()).toBe(baseline + 1);

    // No polling loop behind the seed: silence stays silent.
    await new Promise(r => setTimeout(r, 50));
    expect(statusSeeds()).toBe(baseline + 1);
  });

  it("a turn_ended batch that misses the cursor still re-seeds the gate", async () => {
    render();
    await flush();
    await flush();
    const baseline = statusSeeds();
    // The rows resync heals the cursor; the gate must heal too, not only on in-order batches.
    await fire("chat-rows", rowsPayload({ after: 999, total: 1000, turn_ended: true }));
    await flush();
    expect(statusSeeds()).toBe(baseline + 1);
  });

  it("re-seeds once per chat-session-changed event", async () => {
    render();
    await flush();
    await flush();
    expect(handlers.has("chat-session-changed")).toBe(true);
    const baseline = statusSeeds();
    await fire("chat-session-changed", JSON.stringify({ project: "p", sessionId: "s2" }));
    await flush();
    expect(statusSeeds()).toBe(baseline + 1);
  });

  it("a history view never re-seeds — its status stays 'ended'", async () => {
    render({ sessionId: "hist-1" });
    await flush();
    await flush();
    expect(handlers.has("chat-rows")).toBe(true);
    const baseline = statusSeeds(); // 0: history returns before the mount seed
    await fire("chat-rows", rowsPayload({ sessionId: "hist-1", after: 0, total: 1, turn_ended: true }));
    await flush();
    expect(statusSeeds()).toBe(baseline);
  });
});

// #6201 — the header's read on the wake chain: "kickoff pending" during the idle gate (the
// session's own startup makes the ticker read "working", which is exactly how tiny-timer's 88s
// silent gate read as idle-with-nothing-to-do), then the outcome for the same few seconds the
// sidebar row gives it. The chain events and the mount mark arrive through the deps seam.
describe("Chat wake chain note (#6201)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let invokes: Invoked[];
  let handlers: Map<string, Handler[]>;

  // The emitter delivers an OBJECT; the harness parses the JSON it is handed so the listener sees
  // the wire shape, not a string (#6094: every live frame failed to parse while string tests passed).
  const fireJson = (event: string, payload: string) =>
    act(async () => {
      // SAFETY: the harness hands the listener exactly what the emitter would, the parsed object.
      const wire = JSON.parse(payload) as unknown;
      for (const cb of handlers.get(event) ?? []) cb({ payload: wire });
    });

  const fireProgress = (payload: WakeProgress) =>
    act(async () => {
      // The Handler container's payload is unknown — the structured wake object rides in
      // directly, no cast.
      for (const cb of handlers.get("wake-progress") ?? []) cb({ payload });
    });

  const render = (wakeProjects: string[] = []) => {
    const d = makeDeps(wakeProjects);
    invokes = d.invokes;
    handlers = d.handlers;
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={d.deps} />); });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("a window opened mid-wake reads 'kickoff pending' from the mount mark, and a quiet machine shows no note", async () => {
    render(["p"]);
    await flush();
    expect(handlers.has("wake-progress")).toBe(true);
    expect(invokes.some(c => c.cmd === "wake_in_progress")).toBe(true);
    expect(host.textContent).toContain("kickoff pending — waiting for idle");

    // The mount mark re-read on a project switch: no wake in flight, no note, no dead chrome.
    render([]);
    await flush();
    expect(host.textContent).not.toContain("kickoff pending");
  });

  it("the pending note replaces the session's startup ticker, and the outcome shows for the few seconds then fades", async () => {
    vi.useFakeTimers();
    try {
      render();
      await flush();
      // The exact lie tiny-timer told: the session's own startup reads "working" in the ticker.
      await fireJson("orch-status", JSON.stringify({ project: "p", status: "working" }));
      await flush();
      expect(host.textContent).toContain("working");

      // The gate opens: the wake's truth outranks the startup ticker.
      await fireProgress({ project: "p", phase: "waiting_idle", detail: null });
      await flush();
      expect(host.textContent).toContain("kickoff pending — waiting for idle");
      expect(host.textContent).not.toContain("working");

      // Landed: the outcome in Rust's own words, then gone after WAKE_OUTCOME_MS — the ticker's
      // silence returns (nothing replaces it: idle shows no line, absence IS the idle state).
      await fireProgress({ project: "p", phase: "kickoff_landed", detail: "prompt delivered — successor is recapping" });
      await flush();
      expect(host.textContent).toContain("prompt delivered — successor is recapping");
      await act(async () => { vi.advanceTimersByTime(WAKE_OUTCOME_MS + 1); });
      expect(host.textContent).not.toContain("prompt delivered");
      expect(host.textContent).not.toContain("kickoff pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("another project's chain never shows here; ended clears the note", async () => {
    render();
    await flush();
    await fireProgress({ project: "other", phase: "waiting_idle", detail: null });
    await flush();
    expect(host.textContent).not.toContain("kickoff pending");

    await fireProgress({ project: "p", phase: "waiting_idle", detail: null });
    await flush();
    expect(host.textContent).toContain("kickoff pending — waiting for idle");

    await fireProgress({ project: "p", phase: "ended", detail: null });
    await flush();
    expect(host.textContent).not.toContain("kickoff pending");
  });
});

const askBlock = {
  kind: "tool", text: "Ship it?", tool: "AskUserQuestion", tool_id: "ask1",
  ask: [{
    header: "Ship", question: "Ship it?", multiSelect: false,
    options: [{ label: "Yes", description: "" }, { label: "No", description: "" }],
  }],
};
const askTurn = { role: "assistant", blocks: [askBlock] };

/** A live pane (orchestratorOf resolves a surface) with one blocked AskUserQuestion already in
 *  the backfilled transcript — the render() every test using it starts from. */
function makeBlockedDeps() {
  const answered: Array<{ target: string; data: string }> = [];
  const handlers = new Map<string, Handler[]>();
  const deps: ChatDeps = {
    // The real backend answers `after` — a second fetch past line 0 gets nothing new, never
    // the same turn again. A mock that ignored `after` doubled the ask (2 tool blocks batched
    // into one collapsed "2 tools" row) the instant `target` resolved and re-ran the effect.
    invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
      if (cmd === "orchestrator_chat") {
        // SAFETY: Chat always calls orchestrator_chat with a plain `{ after: number }` object —
        // never the array/buffer arms of InvokeArgs — so this narrow read is exactly what
        // arrives here.
        const after = (args as { after: number } | undefined)?.after ?? 0;
        const backfill = after === 0 ? [[askTurn], [], 1, META, []] : [[], [], after, META, []];
        // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is
        // exactly the Backfill shape this test built above.
        return Promise.resolve(JSON.stringify(backfill) as T);
      }
      if (cmd === "chat_watch") {
        // SAFETY: Chat types this call Promise<ChatWatchResult> — current=1 matches the one
        // turn the backfill above already seeded, so the post-mount watch never re-fetches it.
        return Promise.resolve({ current: 1, generation: 1 } as T);
      }
      if (cmd === "orchestrator_status") {
        // SAFETY: Chat types this call Promise<string> and treats the value as herdr's status
        // text; "blocked" is the one status that surfaces the open ask under test.
        return Promise.resolve("blocked" as T);
      }
      if (cmd === "ask_target") {
        // SAFETY: Chat requests ask_target as string|null; this fixture hosts the ask session.
        return Promise.resolve("surf1" as T);
      }
      if (cmd === "ask_watch") {
        queueMicrotask(() => {
          const payload = {
            project: "p", session_id: "ask-session", tool_use_id: "ask1", open: true,
            questions: askBlock.ask,
          };
          for (const cb of handlers.get("orch-ask") ?? []) cb({ payload });
        });
        // SAFETY: Chat ignores ask_watch's resolved value; the queued event is the result.
        return Promise.resolve(null as T);
      }
      // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
      return Promise.resolve(null as T);
    },
    listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
      // SAFETY: the fake stores the callback unchanged and fires it with its event's own payload.
      handlers.set(event, [...(handlers.get(event) ?? []), cb as Handler]);
      return Promise.resolve(() => {});
    },
    orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
    answerAtSession: async (target: string, data: string) => { answered.push({ target, data }); },
    Composer: () => null,
    TerminalPane: () => null,
  };
  return { deps, answered };
}

// #6094 — the question card: a blocked AskUserQuestion tool_use renders as something the
// operator can answer from Chat, a click writes the picker's real keystrokes into the live pane
// (never a claim of its own), and the card only flips to answered once the transcript's own
// tool_result lands for that call.
describe("orch-status as the Rust emitter sends it (#6094)", () => {
  // The emitter hands the listener an OBJECT; the older tests only ever sent JSON strings, so the
  // live path threw "Unexpected identifier object" on every real frame and the status never moved.
  it("an object payload commits the status instead of failing to parse", async () => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    const handlers = new Map<string, Handler[]>();
    const logged: string[] = [];
    const deps: ChatDeps = {
      invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
        if (cmd === "app_log") {
          // SAFETY: Chat calls app_log with a plain { line } object; the test only records the line.
          const a = args as { line?: unknown } | undefined;
          logged.push(String(a?.line ?? ""));
          // SAFETY: app_log resolves to nothing Chat reads.
          return Promise.resolve(null as T);
        }
        if (cmd === "orchestrator_chat") {
          // SAFETY: Chat types orchestrator_chat as Promise<string> and parses the JSON envelope.
          return Promise.resolve(JSON.stringify([[], [], 0, META, []]) as T);
        }
        if (cmd === "chat_watch") {
          // SAFETY: Chat types chat_watch as Promise<ChatWatchResult>.
          return Promise.resolve({ current: 0, generation: 1 } as T);
        }
        if (cmd === "orchestrator_status") {
          // SAFETY: Chat types orchestrator_status as Promise<string>.
          return Promise.resolve("working" as T);
        }
        // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
        return Promise.resolve(null as T);
      },
      listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
        // SAFETY: the handler is stored under the unknown-payload container and fired with exactly
        // what listen delivered, the same way the harness above does.
        handlers.set(event, [...(handlers.get(event) ?? []), cb as Handler]);
        return Promise.resolve(() => {});
      },
      orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
      answerAtSession: async () => {},
      Composer: () => null,
      TerminalPane: () => null,
    };
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush(); await flush();
    expect(host.textContent).toContain("working");
    await act(async () => { for (const cb of handlers.get("orch-status") ?? []) cb({ payload: { project: "p", status: "blocked" } }); });
    await flush(); await flush();
    expect(logged.some(l => l.includes("FAILED to parse"))).toBe(false);
    expect(host.textContent).not.toContain("working");
    act(() => { root.unmount(); });
  });
});

describe("AskCard question card (#6094)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders the open question as buttons, not a collapsed tool row", async () => {
    const { deps } = makeBlockedDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    expect(host.textContent).toContain("Ship it?");
    const buttons = [...host.querySelectorAll("button")].map(b => b.textContent ?? "");
    expect(buttons.some(t => t.includes("Yes"))).toBe(true);
    expect(buttons.some(t => t.includes("No"))).toBe(true);
  });

  it("picking an option writes answerKeystrokes' arrow-navigation sequence into the pane", async () => {
    const { deps, answered } = makeBlockedDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    const noButton = [...host.querySelectorAll("button")].find(b => (b.textContent ?? "").includes("No"))!;
    await act(async () => { noButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    // "No" is index 1: one Down arrow to reach it, then Enter — never a typed digit.
    expect(answered).toEqual([{ target: "ask-session", data: "\x1b[B\r" }]);
  });

  it("stays a question card (not answered) until the transcript's own tool_result lands", async () => {
    const { deps } = makeBlockedDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    expect(host.textContent).not.toContain("answered");
    expect(host.textContent).toContain("Yes");
  });
});

describe("orch-ask is the pending-card source (#6533)", () => {
  it("opens from the event alone, routes by session, closes, and settles from tool_result", async () => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    const handlers = new Map<string, Handler[]>();
    const answers: Array<{ sessionId: string; data: string }> = [];
    const traces: string[] = [];
    const commands: string[] = [];
    let answered = false;
    let answerTarget: string | null = "w2:p19";
    const deps: ChatDeps = {
      invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
        commands.push(cmd);
        if (cmd === "app_log") {
          // SAFETY: Chat sends app_log the documented object containing a string line.
          const fields = args as { line?: unknown } | undefined;
          traces.push(String(fields?.line ?? ""));
        }
        if (cmd === "orchestrator_chat") {
          const backfill = answered
            ? [[askTurn], [{ tool_id: "ask1", ok: true, preview: "No" }], 1, META, []]
            : [[], [], 0, META, []];
          // SAFETY: Chat requests orchestrator_chat as a JSON string; this is its Backfill shape.
          return Promise.resolve(JSON.stringify(backfill) as T);
        }
        if (cmd === "chat_watch") {
          // SAFETY: Chat assigns this command the exact ChatWatchResult type returned here.
          return Promise.resolve({ current: 0, generation: 1 } as T);
        }
        if (cmd === "orchestrator_status") {
          // SAFETY: orchestrator_status is requested as a status string.
          return Promise.resolve("idle" as T);
        }
        if (cmd === "ask_target") {
          // SAFETY: ask_target is requested as string|null; the drill session lives in w2:p19.
          return Promise.resolve(answerTarget as T);
        }
        // SAFETY: Chat ignores every other command's resolved value in this fixture.
        return Promise.resolve(null as T);
      },
      listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
        // SAFETY: the fake stores the callback unchanged and fires it with its event's payload.
        handlers.set(event, [...(handlers.get(event) ?? []), cb as Handler]);
        return Promise.resolve(() => {});
      },
      orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "w2:p8", kind: "orch" }),
      answerAtSession: async (sessionId, data) => { answers.push({ sessionId, data }); },
      Composer: () => null,
      TerminalPane: () => null,
    };
    const ask = {
      project: "p", session_id: "drill-session", tool_use_id: "ask1", open: true, visible: false,
      questions: askBlock.ask,
    };
    const nullIdAsk = { ...ask, tool_use_id: null };
    const fire = async (event: string, payload: string | AskEventPayload) => {
      await act(async () => { for (const cb of handlers.get(event) ?? []) cb({ payload }); });
      await flush();
    };

    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush(); await flush();
    expect(commands.indexOf("ask_watch")).toBeLessThan(commands.indexOf("orchestrator_chat"));
    expect(commands.indexOf("ask_watch")).toBeLessThan(commands.indexOf("chat_watch"));
    await fire("orch-ask", nullIdAsk);
    expect(host.textContent).toContain("Ship it?");
    expect(traces.some(line => line.includes("ask event in webview session=drill-session"))).toBe(true);
    expect(traces.some(line => line.includes("ask card mounted session=drill-session"))).toBe(true);
    let no = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("No"));
    expect(no?.disabled).toBe(true);
    await fire("orch-ask", { ...nullIdAsk, visible: true });
    no = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("No"));
    expect(no?.disabled).toBe(false);
    expect(traces.some(line => line.includes("ask visible session=drill-session via=permission-request"))).toBe(true);
    await act(async () => { no?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(answers).toEqual([{ sessionId: "drill-session", data: "\x1b[B\r" }]);

    await fire("orch-ask", { ...nullIdAsk, open: false });
    expect(host.querySelector('[data-testid="ask-card"]')).toBeNull();

    answerTarget = null;
    await fire("orch-ask", { ...ask, session_id: "terminal-only", tool_use_id: "ask2" });
    expect(host.textContent).toContain("answer it in its terminal");
    await fire("orch-ask", { ...ask, session_id: "terminal-only", tool_use_id: "ask2", open: false });
    answerTarget = "w2:p19";

    const fallbackAsk = { ...ask, session_id: "fallback-session", tool_use_id: "ask3", visible: false };
    await fire("orch-ask", fallbackAsk);
    let fallbackNo = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("No"));
    expect(fallbackNo?.disabled).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_550)); });
    await flush();
    fallbackNo = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("No"));
    expect(fallbackNo?.disabled).toBe(false);
    expect(traces.some(line => line.includes("ask visible session=fallback-session via=fallback"))).toBe(true);
    await fire("orch-ask", { ...fallbackAsk, open: false });

    await fire("orch-ask", nullIdAsk);
    answered = true;
    await fire("chat-session-changed", JSON.stringify({ project: "p", sessionId: "s1" }));
    expect(host.querySelectorAll('[data-testid="ask-card"]')).toHaveLength(1);
    expect(host.textContent).toContain("answered");
    await fire("orch-ask", nullIdAsk);
    expect(host.querySelectorAll('[data-testid="ask-card"]')).toHaveLength(1);

    act(() => root.unmount());
    host.remove();
  });
});

// #5993 regression: an open AskUserQuestion carries its question as structured options, and the prose
// extractor produced zero chips. Mounts Chat with a REAL blocked-ask transcript and expects the
// suggestion row to show the options, answering via keystrokes into the pane like the card does.
describe("suggestion chips from an open AskUserQuestion (#5993)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows a chip per option above the composer for a real blocked-ask transcript", async () => {
    const { deps } = makeBlockedDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    const chips = host.querySelector('[data-testid="suggestion-chips"]');
    expect(chips).not.toBeNull();
    const chipLabels = [...chips!.querySelectorAll("button")].map(b => b.textContent ?? "");
    expect(chipLabels).toContain("Yes");
    expect(chipLabels).toContain("No");
  });

  it("clicking a chip answers via keystrokes into the live pane, not a composer send", async () => {
    const { deps, answered } = makeBlockedDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    const chips = host.querySelector('[data-testid="suggestion-chips"]')!;
    const noChip = [...chips.querySelectorAll("button")].find(b => (b.textContent ?? "") === "No")!;
    await act(async () => { noChip.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    // "No" is index 1: one Down arrow to reach it, then Enter — the exact bytes the ask card's
    // own button sends (#6094), proving the chip took the keystroke path, not the composer's.
    expect(answered).toEqual([{ target: "ask-session", data: "\x1b[B\r" }]);
  });
});

// #6094 REGRESSION: a real AskUserQuestion rendered NOTHING in Chat though status went "blocked".
// Claude Code writes one JSONL row per content block, so a real backfill arrives as several
// consecutive single-block assistant turns, not one turn with several blocks. This fixture is
// decoded from the operator's own transcript, truncated before the tool_result so the ask is open.
const REAL_ASK_TURNS = [
  { role: "user", blocks: [{ kind: "text", text: "check", tool: null, tool_id: null }] },
  {
    role: "assistant",
    blocks: [{
      kind: "tool",
      text: "cd /Users/sashabogojevic/development/trantor; date '+now %H:%M' ...",
      tool: "Bash",
      tool_id: "toolu_01DuwZ2wGQ6Lx65R5PfKVVZw",
    }],
  },
  {
    role: "assistant",
    blocks: [{
      kind: "thinking",
      text: "Version 0.3.142 is confirmed running. This test covers two behaviors at once: the question should appear as a card in Chat, and since it's the end of my turn, chips should also show above the composer — feel free to click either.",
      tool: null,
      tool_id: null,
    }],
  },
  {
    role: "assistant",
    blocks: [{
      kind: "tool",
      text: "On 0.3.142, did the card click (or a chip) answer this question?",
      tool: "AskUserQuestion",
      tool_id: "toolu_015iF3HWfSUDymVCyin3jdjG",
      ask: [{
        header: "Drill",
        question: "On 0.3.142, did the card click (or a chip) answer this question?",
        multiSelect: false,
        options: [
          { label: "Yes, it answered", description: "Clicking an option on the card or a chip moved the terminal menu and answered" },
          { label: "No, nothing happened", description: "The card or chips showed but clicking did nothing" },
          { label: "No card or chips", description: "The question did not render as a card, or no chips appeared" },
        ],
      }],
    }],
  },
];
const REAL_ASK_RESULTS = [{
  tool_id: "toolu_01DuwZ2wGQ6Lx65R5PfKVVZw", ok: true,
  preview: "now 17:26\nVALID\ninstalled: 0.3.142\nrunning pid 3570",
}];
const REAL_ASK_META = {
  model: "claude-fable-5-1", version: "2.1.257", branch: "main",
  context: { tokens: 712270, window: 1000000, frac: 0.71227 },
};

function makeRealTranscriptDeps() {
  const answered: Array<{ target: string; data: string }> = [];
  const traced: string[] = [];
  const deps: ChatDeps = {
    invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
      if (cmd === "app_log") {
        // SAFETY: Chat/herdr trace calls always pass { line: string }.
        traced.push((args as { line: string } | undefined)?.line ?? "");
        // SAFETY: Chat types app_log's return as void; the seam ignores whatever comes back.
        return Promise.resolve(undefined as T);
      }
      if (cmd === "orchestrator_chat") {
        // SAFETY: Chat always calls orchestrator_chat with a plain `{ after: number }` object.
        const after = (args as { after: number } | undefined)?.after ?? 0;
        const backfill = after === 0
          ? [REAL_ASK_TURNS, REAL_ASK_RESULTS, 33, REAL_ASK_META, ["check"]]
          : [[], [], after, REAL_ASK_META, []];
        // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is
        // exactly the Backfill shape this test built above.
        return Promise.resolve(JSON.stringify(backfill) as T);
      }
      if (cmd === "chat_watch") {
        // SAFETY: Chat types this call Promise<ChatWatchResult>; current=33 matches the fixture's
        // own total, so the post-mount watch never re-fetches what the backfill already seeded.
        return Promise.resolve({ current: 33, generation: 1 } as T);
      }
      if (cmd === "orchestrator_status") {
        // SAFETY: Chat types this call Promise<string>; "blocked" is the one status that surfaces
        // the open ask under test.
        return Promise.resolve("blocked" as T);
      }
      // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
      return Promise.resolve(null as T);
    },
    listen: () => Promise.resolve(() => {}),
    orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
    answerAtSession: async (target: string, data: string) => { answered.push({ target, data }); },
    Composer: () => null,
    TerminalPane: () => null,
  };
  return { deps, answered, traced };
}

describe("the transcript is history, not the pending-ask source (#6533)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("does not open a card from a result-less transcript tool_use", async () => {
    const { deps } = makeRealTranscriptDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    expect(host.querySelector('[data-testid="ask-card"]')).toBeNull();
    expect(host.textContent).not.toContain("On 0.3.142, did the card click");
  });

  it("does not derive pending chips from the transcript", async () => {
    const { deps } = makeRealTranscriptDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    const chips = host.querySelector('[data-testid="suggestion-chips"]');
    expect(chips).toBeNull();
  });
});

// Same real-shape data, delivered the way the LIVE app delivers it: Chat mounted and idle, then the
// ask's rows arrive via "chat-rows" PUSH in two batches, then an "orch-status" push flips to
// blocked (rows land before the status push live). Proves the PUSH path (applyRows), not only backfill.
describe("real transcript regression via the PUSH path (chat-rows then orch-status)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders the ask card once its rows arrive via chat-rows, then status flips blocked via orch-status", async () => {
    const handlers = new Map<string, Handler[]>();
    const deps: ChatDeps = {
      invoke: <T,>(cmd: string): Promise<T> => {
        if (cmd === "orchestrator_chat") {
          // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is an
          // empty Backfill — this test starts Chat idle and delivers the ask via chat-rows below.
          return Promise.resolve(JSON.stringify([[], [], 0, REAL_ASK_META, []]) as T);
        }
        if (cmd === "chat_watch") {
          // SAFETY: Chat types this call Promise<ChatWatchResult> — current=0 matches the empty
          // backfill above.
          return Promise.resolve({ current: 0, generation: 1 } as T);
        }
        if (cmd === "orchestrator_status") {
          // SAFETY: Chat types this call Promise<string>; the pane starts "working" — blocked
          // arrives later via the orch-status push under test.
          return Promise.resolve("working" as T);
        }
        if (cmd === "ask_target") {
          // SAFETY: Chat requests ask_target as string|null; this fixture hosts the ask session.
          return Promise.resolve("surf1" as T);
        }
        // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
        return Promise.resolve(null as T);
      },
      listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
        // SAFETY: the handler is stored under the unknown-payload container (Handler, above) and
        // fired with exactly what listen delivered — this test only fires "chat-rows" and
        // "orch-status", both string payloads.
        const boxed = cb as Handler;
        handlers.set(event, [...(handlers.get(event) ?? []), boxed]);
        return Promise.resolve(() => {});
      },
      orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
      answerAtSession: async () => {},
      Composer: () => null,
      TerminalPane: () => null,
    };
    const fire = (event: string, payload: string | AskEventPayload) =>
      act(async () => { for (const cb of handlers.get(event) ?? []) cb({ payload }); });

    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    expect(handlers.has("chat-rows")).toBe(true);

    // Batch 1: the Bash call + its thinking block land first.
    await fire("chat-rows", JSON.stringify({
      project: "p", sessionId: "s1", after: 0, total: 3,
      turns: [REAL_ASK_TURNS[1], REAL_ASK_TURNS[2]],
      results: REAL_ASK_RESULTS, meta: REAL_ASK_META, receiptTexts: [],
    }));
    await flush();

    // Batch 2: the AskUserQuestion tool_use itself.
    await fire("chat-rows", JSON.stringify({
      project: "p", sessionId: "s1", after: 3, total: 4,
      turns: [REAL_ASK_TURNS[3]],
      results: [], meta: REAL_ASK_META, receiptTexts: [],
    }));
    await flush();

    // herdr flips the pane to blocked once the tool_use lands.
    await fire("orch-status", JSON.stringify({ project: "p", status: "blocked" }));
    await flush();
    await flush();

    await fire("orch-ask", {
      project: "p", session_id: "s1", tool_use_id: "toolu_real_ask", open: true, visible: true,
      questions: "ask" in REAL_ASK_TURNS[3].blocks[0] ? REAL_ASK_TURNS[3].blocks[0].ask : [],
    });
    await flush();

    expect(host.textContent).toContain("On 0.3.142, did the card click");
    const buttons = [...host.querySelectorAll("button")].map(b => b.textContent ?? "");
    expect(buttons.some(t => t.includes("Yes, it answered"))).toBe(true);
    const chips = host.querySelector('[data-testid="suggestion-chips"]');
    expect(chips).not.toBeNull();
  });
});

// #6094 root cause: two concurrent orchestrator_chat backfills. The mount effect's sync() and its
// re-run when `target` resolves (#5495) were both dispatched with a stale after=0; the later,
// larger one hit the "heal the cursor" branch, bumped `seen` past the ask and dropped its turns,
// so no future sync() ever re-fetched it.
describe("concurrent backfill data loss (#6094 root cause, 2026-09-05)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("does not lose the ask when a second concurrent backfill resolves after the first", async () => {
    type Resolver = (raw: string) => void;
    // sync()'s busy-guard collapses the second concurrent dispatch into a deferred "pending"
    // catch-up, so only ONE call is held open here; the catch-up that fires on resolve is the
    // recovery re-sync, auto-answered from wherever its `after` says the cursor sits.
    const manual: Resolver[] = [];
    let resolvePane: (() => void) | null = null;

    const deps: ChatDeps = {
      invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
        if (cmd === "orchestrator_chat") {
          // SAFETY: Chat always calls orchestrator_chat with a plain `{ after: number }` object.
          const after = (args as { after: number } | undefined)?.after ?? 0;
          if (manual.length < 1) {
            // SAFETY: Chat types this call Promise<string>; the manual resolver below always
            // hands it a JSON-stringified Backfill.
            return new Promise<string>(resolve => { manual.push(resolve); }) as Promise<T>;
          }
          // The recovery re-sync: answers from the real cursor (after=1, past "check"), carrying
          // everything from there through the ask.
          expect(after).toBe(1);
          const backfill = [REAL_ASK_TURNS.slice(1), REAL_ASK_RESULTS, 33, REAL_ASK_META, []];
          // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is
          // exactly the Backfill shape built above.
          return Promise.resolve(JSON.stringify(backfill) as T);
        }
        if (cmd === "chat_watch") {
          // SAFETY: Chat types this call Promise<ChatWatchResult>; the exact generation value is
          // never asserted on, only that a watcher exists.
          return Promise.resolve({ current: 0, generation: manual.length } as T);
        }
        if (cmd === "orchestrator_status") {
          // SAFETY: Chat types this call Promise<string>; "blocked" is the one status that
          // surfaces the open ask under test.
          return Promise.resolve("blocked" as T);
        }
        // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
        return Promise.resolve(null as T);
      },
      listen: () => Promise.resolve(() => {}),
      // Resolves on the SECOND call (mirrors #5495's "keep looking" poll finding the pane after
      // the mount effect has already run once with target=null) — never on the first, so the
      // chat_watch effect is guaranteed to tear down and re-run at least once.
      orchestratorOf: async () => {
        if (!resolvePane) {
          await new Promise<void>(r => { resolvePane = r; });
        }
        return { project: "p", agent: "orch", surface: "surf1", kind: "orch" };
      },
      answerAtSession: async () => {},
      Composer: () => null,
      TerminalPane: () => null,
    };

    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    // Let the pane resolve now, forcing the chat_watch effect to tear down and re-run — a second
    // concurrent orchestrator_chat call fires while the first is still unresolved.
    act(() => { resolvePane?.(); });
    await flush();
    await flush();

    expect(manual.length).toBe(1);
    // The one held-open call resolves: a small backfill, no ask yet. Its OWN completion is what
    // fires the deferred catch-up (the mount re-run's sync() call that the busy-guard put on
    // hold) — that catch-up's mocked answer (above) carries the ask, from the real cursor.
    act(() => { manual[0](JSON.stringify([[REAL_ASK_TURNS[0]], [], 1, REAL_ASK_META, ["check"]])); });
    await flush();
    await flush();

    expect(host.textContent).toContain("thinking");
    expect(host.querySelector('[data-testid="ask-card"]')).toBeNull();
  });
});

// #6094 REAL-PATH REGRESSION: chat_watch gen 1, chat_unwatch, chat_watch gen 2 (target resolving
// null → pane, #5495), then herdr's blocked emit, then NOTHING. Cleanup read the generation ref
// SYNCHRONOUSLY before gen 1's chat_watch had resolved, sent the generation-less unwatch, and
// killed gen 2's Rust watcher too, leaving a listener no thread would ever push a frame to.
describe("chat_unwatch never sends a stale generation-less unwatch (#6094 real-path, 2026-09-05)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("waits for generation 1's own chat_watch answer before unwatching, instead of guessing null", async () => {
    type Invoked = { cmd: string; args: unknown };
    const invokes: Invoked[] = [];
    const watchResolvers: Array<(r: { current: number; generation: number }) => void> = [];
    let resolvePane: (() => void) | null = null;

    const deps: ChatDeps = {
      invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
        invokes.push({ cmd, args });
        if (cmd === "chat_watch") {
          // SAFETY: Chat types this call Promise<ChatWatchResult>; the test controls resolution
          // order explicitly below via watchResolvers, typed to exactly that shape.
          return new Promise<{ current: number; generation: number }>(resolve => {
            watchResolvers.push(resolve);
          }) as Promise<T>;
        }
        if (cmd === "chat_unwatch") {
          // SAFETY: Chat types chat_unwatch's return as void.
          return Promise.resolve(undefined as T);
        }
        if (cmd === "orchestrator_chat") {
          // SAFETY: Chat types this call Promise<string> and parses the JSON; an empty Backfill
          // keeps this test focused on the watch/unwatch plumbing, not the transcript contents.
          return Promise.resolve(JSON.stringify([[], [], 0, REAL_ASK_META, []]) as T);
        }
        if (cmd === "orchestrator_status") {
          // SAFETY: Chat types this call Promise<string>; the exact status is irrelevant here.
          return Promise.resolve("working" as T);
        }
        // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
        return Promise.resolve(null as T);
      },
      listen: () => Promise.resolve(() => {}),
      // Resolves on the SECOND call — mirrors #5495's "keep looking" poll finding the pane after
      // the mount effect already ran once with target=null, forcing the chat_watch effect to
      // tear down and re-run while generation 1's chat_watch is still unresolved.
      orchestratorOf: async () => {
        if (!resolvePane) {
          await new Promise<void>(r => { resolvePane = r; });
        }
        return { project: "p", agent: "orch", surface: "surf1", kind: "orch" };
      },
      answerAtSession: async () => {},
      Composer: () => null,
      TerminalPane: () => null,
    };

    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    // Force the remount: target flips null -> "surf1", tearing generation 1's effect down before
    // its own chat_watch has resolved.
    act(() => { resolvePane?.(); });
    await flush();
    await flush();

    expect(watchResolvers.length).toBe(2);
    // Cleanup must NOT have fired chat_unwatch yet — generation 1's own answer is still pending,
    // so there is nothing honest to send.
    expect(invokes.filter(i => i.cmd === "chat_unwatch")).toEqual([]);

    // NOW generation 1 answers. Cleanup was waiting on exactly this.
    act(() => { watchResolvers[0]({ current: 0, generation: 1 }); });
    await flush();
    await flush();

    const unwatches = invokes.filter(i => i.cmd === "chat_unwatch");
    expect(unwatches).toHaveLength(1);
    // The bug: this used to be `{ generation: null }` — a fallback that removes whatever watcher
    // is CURRENTLY live for the key, which by now is generation 2's, not generation 1's own.
    expect(unwatches[0].args).toMatchObject({ generation: 1 });
  });
});
// #6094 real-path bounce: the live push emitted ok=true on the Rust side with no "chat status"
// line following; the listener's silent catch and project-mismatch fall-through left zero
// evidence. Every arrival now traces itself, naming which outcome happened.
describe("orch-status listener traces every arrival, never silently (#6094, 2026-09-05)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function makeTracingDeps() {
    const handlers = new Map<string, Handler[]>();
    const appLogLines: string[] = [];
    const deps: ChatDeps = {
      invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
        if (cmd === "app_log") {
          // SAFETY: every app_log call in Chat.tsx passes a plain `{ line: string }` object.
          appLogLines.push((args as { line: string } | undefined)?.line ?? "");
          // SAFETY: this stub's only caller awaits void app_log calls, never reads the resolved value.
          return Promise.resolve(undefined as T);
        }
        if (cmd === "orchestrator_chat") {
          // SAFETY: T is inferred as `string` at every orchestrator_chat call site in Chat.tsx.
          return Promise.resolve(JSON.stringify([[], [], 0, REAL_ASK_META, []]) as T);
        }
        if (cmd === "chat_watch") {
          // SAFETY: T is inferred as `{ current: number; generation: number }` at chat_watch's call site.
          return Promise.resolve({ current: 0, generation: 1 } as T);
        }
        if (cmd === "orchestrator_status") {
          // SAFETY: T is inferred as `string` at orchestrator_status's call site.
          return Promise.resolve("working" as T);
        }
        // SAFETY: every other command Chat.tsx invokes ignores its resolved value (fire-and-forget).
        return Promise.resolve(null as T);
      },
      listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
        // SAFETY: this fake listener only ever forwards the payload untouched to the caller's own
        // typed callback — the cast just widens it to the shared Handler bag's storage type.
        const boxed = cb as Handler;
        handlers.set(event, [...(handlers.get(event) ?? []), boxed]);
        return Promise.resolve(() => {});
      },
      orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
      answerAtSession: async () => {},
      Composer: () => null,
      TerminalPane: () => null,
    };
    return { deps, handlers, appLogLines };
  }

  it("traces a project mismatch instead of silently dropping it", async () => {
    const { deps, handlers, appLogLines } = makeTracingDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();

    await act(async () => {
      for (const cb of handlers.get("orch-status") ?? []) {
        cb({ payload: JSON.stringify({ project: "some-other-project", status: "blocked" }) });
      }
      await Promise.resolve();
    });

    expect(appLogLines.some(l => l.includes("did not match") && l.includes("some-other-project"))).toBe(true);
  });

  it("traces a parse failure instead of silently swallowing it", async () => {
    const { deps, handlers, appLogLines } = makeTracingDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();

    await act(async () => {
      for (const cb of handlers.get("orch-status") ?? []) cb({ payload: "not valid json" });
      await Promise.resolve();
    });

    expect(appLogLines.some(l => l.includes("FAILED to parse") && l.includes("not valid json"))).toBe(true);
  });

  it("still commits a genuine match — tracing never blocks the real path", async () => {
    const { deps, handlers, appLogLines } = makeTracingDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();

    await act(async () => {
      for (const cb of handlers.get("orch-status") ?? []) {
        cb({ payload: JSON.stringify({ project: "p", status: "blocked" }) });
      }
      await Promise.resolve();
    });

    expect(appLogLines.some(l => l.includes("chat status p: push=blocked"))).toBe(true);
    expect(appLogLines.some(l => l.includes("did not match") || l.includes("FAILED to parse"))).toBe(false);
  });
});
// #6094 root cause, second half: batch() groups every CONSECUTIVE tool block into one array and
// ToolRun collapses arrays longer than 1 behind a closed "N tools" toggle. A tool call followed
// DIRECTLY by an AskUserQuestion (no thinking between) hid the ask behind "2 tools".
const ADJACENT_ASK_TURNS = [
  { role: "user" as const, blocks: [{ kind: "text" as const, text: "check", tool: undefined, tool_id: undefined }] },
  {
    role: "assistant" as const,
    blocks: [
      { kind: "tool" as const, text: "git status", tool: "Bash", tool_id: "toolu_bash1" },
      {
        kind: "tool" as const,
        text: "Push now?",
        tool: "AskUserQuestion",
        tool_id: "toolu_ask1",
        ask: [{
          header: "Drill", question: "Push now?", multiSelect: false,
          options: [{ label: "Yes", description: "" }, { label: "No", description: "" }],
        }],
      },
    ],
  },
];
const ADJACENT_ASK_RESULTS = [
  { tool_id: "toolu_bash1", ok: true, preview: "nothing to commit" },
  { tool_id: "toolu_ask1", ok: true, preview: "Yes" },
];

describe("an ask adjacent to another tool call in the same turn (#6094, 2026-09-05)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("still renders an answered historical ask, not a collapsed \"2 tools\" toggle", async () => {
    const deps: ChatDeps = {
      invoke: <T,>(cmd: string): Promise<T> => {
        if (cmd === "orchestrator_chat") {
          // SAFETY: T is inferred as `string` at orchestrator_chat's call site; this envelope is
          // the Backfill shape [turns, results, total, meta, receiptTexts].
          return Promise.resolve(JSON.stringify([ADJACENT_ASK_TURNS, ADJACENT_ASK_RESULTS, 2, REAL_ASK_META, []]) as T);
        }
        if (cmd === "chat_watch") {
          // SAFETY: T is inferred as ChatWatchResult; current=2 matches this fixture's own total.
          return Promise.resolve({ current: 2, generation: 1 } as T);
        }
        if (cmd === "orchestrator_status") {
          // SAFETY: T is inferred as `string`; "blocked" is what surfaces the open ask under test.
          return Promise.resolve("blocked" as T);
        }
        // SAFETY: every other command this fixture's Chat mount invokes ignores its resolved value.
        return Promise.resolve(null as T);
      },
      listen: () => Promise.resolve(() => {}),
      orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
      answerAtSession: async () => {},
      Composer: () => null,
      TerminalPane: () => null,
    };

    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();

    expect(host.querySelector('[data-testid="ask-card"]')).not.toBeNull();
    expect(host.textContent).toContain("Yes");
    expect(host.textContent).toContain("answered");
  });
});

// #6668: the handoff offer needs a LIVE agent in the pane. A Chat once opened onto a pane whose
// claude had died, read the dead transcript at 92%, and fired a chain that would have ended the
// pane's shell. Banner, countdown and auto-fire hang off `bannerOffered`; pinned to liveness.
describe("the handoff offer needs a live agent in the pane (#6668)", () => {
  const OVER_META = {
    model: "claude-fable-5-1", version: "2.1.257", branch: "main",
    context: { tokens: 920_000, window: 1_000_000, frac: 0.92 },
  };
  let host: HTMLDivElement;
  let root: Root;

  /** A pane is hosted (target non-null) and its status seed answers `status`; the transcript
   *  gauge reads 92%. `longRun` makes the injected Composer report full-auto on mount, the
   *  exact input the unattended auto-fire keys on. */
  function makeOverDeps(status: string, longRun = false) {
    const invokes: Array<{ cmd: string; args?: InvokeArgs }> = [];
    const traced: string[] = [];
    const deps: ChatDeps = {
      invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
        invokes.push({ cmd, args });
        if (cmd === "app_log") {
          // SAFETY: Chat's trace calls always pass { line: string }.
          traced.push((args as { line: string } | undefined)?.line ?? "");
          // SAFETY: Chat types app_log's return as void; the seam ignores whatever comes back.
          return Promise.resolve(undefined as T);
        }
        if (cmd === "orchestrator_chat") {
          // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is the
          // Backfill shape with a gauge over HANDOFF_WARN_FRAC.
          return Promise.resolve(JSON.stringify([[], [], 0, OVER_META, []]) as T);
        }
        if (cmd === "chat_watch") {
          // SAFETY: Chat types this call Promise<ChatWatchResult>.
          return Promise.resolve({ current: 0, generation: 1 } as T);
        }
        if (cmd === "orchestrator_status") {
          // SAFETY: Chat types this call Promise<string> — herdr's status word for the pane.
          return Promise.resolve(status as T);
        }
        if (cmd === "handoff_now") {
          // SAFETY: Chat types this call Promise<string> — the chain's returned line.
          return Promise.resolve("handoff drilled" as T);
        }
        // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
        return Promise.resolve(null as T);
      },
      listen: () => Promise.resolve(() => {}),
      orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "w9:p1", kind: "orch" }),
      answerAtSession: async () => {},
      Composer: ({ onLongRunChange }) => {
        useEffect(() => { onLongRunChange(longRun); }, [onLongRunChange]);
        return null;
      },
      TerminalPane: () => null,
    };
    return { deps, invokes, traced };
  }
  const handoffs = (invokes: Array<{ cmd: string; args?: InvokeArgs }>) =>
    // SAFETY: Chat always invokes handoff_now with { project, reason } (startHandoff, Chat.tsx).
    invokes.filter(c => c.cmd === "handoff_now").map(c => (c.args as { reason: string } | undefined)?.reason);
  const bannerButton = () =>
    Array.from(host.querySelectorAll("button")).find(b => b.textContent?.trim() === "Hand off now") ?? null;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("a registered pane with no agent (status unknown) at 92% shows no banner and never fires", async () => {
    const { deps, invokes, traced } = makeOverDeps("unknown", true);
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush(); await flush();
    expect(bannerButton()).toBeNull();
    // The countdown clock and the auto-fire both get their full chance.
    await act(async () => { vi.advanceTimersByTime(HANDOFF_COUNTDOWN_MS + 2_000); });
    await flush();
    expect(handoffs(invokes)).toEqual([]);
    expect(bannerButton()).toBeNull();
    const withheld = traced.filter(l => l.startsWith("chat handoff gauge p:") && l.includes("withheld"));
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toContain("status=unknown");
    expect(withheld[0]).toContain("frac=0.92");
  });

  it("no pane recorded at all (status none) is the same silence", async () => {
    const { deps, invokes } = makeOverDeps("none", true);
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush(); await flush();
    await act(async () => { vi.advanceTimersByTime(HANDOFF_COUNTDOWN_MS + 2_000); });
    await flush();
    expect(handoffs(invokes)).toEqual([]);
    expect(bannerButton()).toBeNull();
  });

  it("a live agent at 92% still gets the banner, and the countdown still fires", async () => {
    const { deps, invokes, traced } = makeOverDeps("idle");
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush(); await flush();
    expect(bannerButton()).not.toBeNull();
    expect(traced.some(l => l.includes("banner withheld"))).toBe(false);
    await act(async () => { vi.advanceTimersByTime(HANDOFF_COUNTDOWN_MS + 500); });
    await flush();
    expect(handoffs(invokes)).toEqual(["countdown"]);
  });

  it("a live agent in full auto fires the unattended handoff exactly as before", async () => {
    const { deps, invokes } = makeOverDeps("working", true);
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush(); await flush(); await flush();
    expect(handoffs(invokes)).toEqual(["unattended"]);
  });
});

describe("the transcript stays put while you read (#6697)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let handlers: Map<string, Handler[]>;
  let scrolls: ReturnType<typeof vi.spyOn>;

  const fire = (event: string, payload: string) =>
    act(async () => { for (const cb of handlers.get(event) ?? []) cb({ payload }); });
  const turnRows = (after: number) => JSON.stringify({
    project: "p", sessionId: "s1", after, total: after + 1, results: [], meta: META,
    turns: [{ role: "assistant", blocks: [{ kind: "text", text: `line ${after}` }] }],
  });
  const transcript = () => {
    const el = host.querySelector<HTMLDivElement>(".overflow-y-auto");
    if (!el) throw new Error("transcript container missing");
    return el;
  };
  const jump = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Jump to latest"]');
  /** Fake a tall transcript in a short viewport and park the scroll position. */
  const scrollTo = (top: number) => {
    const el = transcript();
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    el.scrollTop = top;
    act(() => { el.dispatchEvent(new Event("scroll")); });
  };

  beforeEach(async () => {
    scrolls = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const d = makeDeps();
    handlers = d.handlers;
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={d.deps} />); });
    await flush();
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    scrolls.mockRestore();
  });

  it("pinned at the foot: a new turn follows to the bottom and no jump button shows", async () => {
    const before = scrolls.mock.calls.length;
    await fire("chat-rows", turnRows(0));
    await flush();
    expect(scrolls.mock.calls.length).toBe(before + 1);
    expect(jump()).toBeNull();
  });

  it("scrolled up: a new turn leaves the viewport where it is, and the arrow shows with a new-below dot", async () => {
    scrollTo(100);
    const btn = jump();
    expect(btn).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-unseen"]')).toBeNull();

    const before = scrolls.mock.calls.length;
    await fire("chat-rows", turnRows(0));
    await flush();
    expect(scrolls.mock.calls.length).toBe(before);
    expect(transcript().scrollTop).toBe(100);
    expect(host.querySelector('[data-testid="chat-unseen"]')).not.toBeNull();
    expect(jump()?.getAttribute("aria-label")).toContain("new messages below");
  });

  it("clicking the arrow returns to the latest and hides itself", async () => {
    scrollTo(100);
    await fire("chat-rows", turnRows(0));
    await flush();
    const before = scrolls.mock.calls.length;
    const btn = jump();
    expect(btn).not.toBeNull();
    act(() => { btn?.click(); });
    expect(scrolls.mock.calls.length).toBe(before + 1);
    expect(jump()).toBeNull();

    // Re-pinned: the next turn follows again.
    await fire("chat-rows", turnRows(1));
    await flush();
    expect(scrolls.mock.calls.length).toBe(before + 2);
  });

  it("scrolling back within the threshold re-pins without the button", () => {
    scrollTo(100);
    expect(jump()).not.toBeNull();
    scrollTo(680); // 1000 - 680 - 300 = 20px from the foot, inside PIN_THRESHOLD_PX
    expect(jump()).toBeNull();
  });
});

describe("prose chips read with their question (#6702)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("a prose yes/no ask chips yes/no with the question as lead-in and tooltip", async () => {
    const d = makeDeps();
    // A hosted pane so the chips have a target; the ask arrives the live way, via chat-rows.
    const deps: ChatDeps = { ...d.deps, orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }) };
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    const ask = "Want me to verify those handoff cards?";
    await act(async () => {
      for (const cb of d.handlers.get("chat-rows") ?? []) cb({ payload: JSON.stringify({
        project: "p", sessionId: "s1", after: 0, total: 1, results: [], meta: META,
        turns: [{ role: "assistant", blocks: [{ kind: "text", text: `Both are parked in testing. ${ask}` }] }],
      }) });
    });
    await flush();
    const chips = host.querySelector('[data-testid="suggestion-chips"]');
    expect(chips).not.toBeNull();
    expect(chips!.querySelector('[data-testid="suggestion-lead-in"]')!.textContent).toBe(ask);
    const buttons = [...chips!.querySelectorAll("button")].filter(b => b.textContent !== "×");
    expect(buttons.map(b => b.textContent)).toEqual(["yes", "no"]);
    expect(buttons.map(b => b.title)).toEqual([ask, ask]);
  });
});

// #5993, third reopen (app 0.3.162) — every reopen was diagnosed in code while the built app
// showed nothing, so the app now says WHY the row is hidden: one app_log line naming the first
// gate input that failed, deduped, and never a line while the chips are showing. The extractor
// case carries the turn's tail, which is the idiom the extractor missed.
describe("chip trace: the app names the input that hid the chips (#5993)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function tracingDeps(hosted = true) {
    const d = makeDeps();
    const lines: string[] = [];
    const deps: ChatDeps = {
      ...d.deps,
      invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
        if (cmd === "app_log") {
          // SAFETY: every app_log call in Chat.tsx passes a plain `{ line: string }` object.
          lines.push((args as { line: string } | undefined)?.line ?? "");
        }
        return d.deps.invoke<T>(cmd, args);
      },
      orchestratorOf: async () => hosted ? { project: "p", agent: "orch", surface: "surf1", kind: "orch" } : null,
    };
    return { deps, handlers: d.handlers, lines };
  }

  const chipLines = (lines: string[]) => lines.filter(l => l.startsWith("chat chips p:"));

  async function land(handlers: Map<string, Handler[]>, text: string) {
    await act(async () => {
      for (const cb of handlers.get("chat-rows") ?? []) cb({ payload: JSON.stringify({
        project: "p", sessionId: "s1", after: 0, total: 1, results: [], meta: META,
        turns: [{ role: "assistant", blocks: [{ kind: "text", text }] }],
      }) });
    });
    await flush();
  }

  it("an idle ask-less turn traces the extractor gap once, with the turn's tail", async () => {
    const { deps, handlers, lines } = tracingDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    await land(handlers, "Landed on the seat.\n\nNothing to swap.");
    await flush();
    expect(host.querySelector('[data-testid="suggestion-chips"]')).toBeNull();
    expect(chipLines(lines)).toEqual([
      'chat chips p: hidden by suggestions.length===0 (last turn ends: "Landed on the seat. Nothing to swap.")',
    ]);
  });

  it("a working orchestrator traces 'working', and the pushed idle flips the row on with no further line", async () => {
    const { deps, handlers, lines } = tracingDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    await act(async () => {
      for (const cb of handlers.get("orch-status") ?? []) cb({ payload: JSON.stringify({ project: "p", status: "working" }) });
    });
    await land(handlers, "Staged on the seat. Say the word and it goes in.");
    expect(host.querySelector('[data-testid="suggestion-chips"]')).toBeNull();
    expect(chipLines(lines)).toEqual(["chat chips p: hidden by working"]);
    await act(async () => {
      for (const cb of handlers.get("orch-status") ?? []) cb({ payload: JSON.stringify({ project: "p", status: "idle" }) });
    });
    await flush();
    const chips = host.querySelector('[data-testid="suggestion-chips"]');
    expect(chips).not.toBeNull();
    expect([...chips!.querySelectorAll("button")].filter(b => b.textContent !== "×").map(b => b.textContent)).toEqual(["yes"]);
    expect(chipLines(lines)).toEqual(["chat chips p: hidden by working"]);
  });

  it("no hosted pane traces 'no target'", async () => {
    const { deps, handlers, lines } = tracingDeps(false);
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    await land(handlers, "Just say the word and I'll ship it.");
    expect(chipLines(lines)).toEqual(["chat chips p: hidden by no target"]);
  });
});
