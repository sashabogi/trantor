// @vitest-environment happy-dom
//
// #5993 — the working gate's belt. The pushed status stream can freeze on `working`, so the
// chat re-seeds the status ONCE when the transcript says a turn ended (a `chat-rows` batch
// carrying `turn_ended`) and once per `chat-session-changed`. The chat's tauri/herdr seams are
// INJECTED through the ChatDeps prop (real interface — the same pattern TerminalPane's `deps`
// uses), and the assertions count `orchestrator_status` invokes, so a missing seed, a duplicate,
// or a polling loop all fail loudly.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { Chat, type ChatDeps, FAST_RETRY_MS, FAST_RETRY_WINDOW_MS } from "./Chat";
import type { HerdrSeat } from "../workspace/herdr";
import { WAKE_OUTCOME_MS } from "../genesis/wakeRow";
import type { WakeProgress } from "../genesis/wakeProgress";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Invoked = { cmd: string };
// The container holds handlers for BOTH payload shapes the chat listens to: chat-rows /
// chat-session-changed / orch-status arrive as JSON strings, wake-progress as a structured
// object. `unknown` is the honest payload type — the fires narrow it, never a cast.
type Handler = (ev: { payload: unknown }) => void;

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
    answerAtPane: async () => {},
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
      // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
      return Promise.resolve(null as T);
    },
    listen: () => Promise.resolve(() => {}),
    orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
    answerAtPane: async (target: string, data: string) => { answered.push({ target, data }); },
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
      answerAtPane: async () => {},
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
    expect(answered).toEqual([{ target: "surf1", data: "\x1b[B\r" }]);
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

// #5993 — the regression: an open AskUserQuestion's tool_use block carries the question as
// structured options, not a sentence, so the prose extractor (which only reads `kind === "text"`
// blocks) saw an empty string and produced zero chips for the ask shape the orchestrator now
// asks with most often. This mounts Chat with a REAL blocked-ask transcript (the same fixture
// #6094's card renders from, above) and expects the suggestion row, not just the card, to show
// the options — and a chip click to answer the SAME way the card's own button does: keystrokes
// into the live pane, never a composer send.
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
    expect(answered).toEqual([{ target: "surf1", data: "\x1b[B\r" }]);
  });
});

// #6094 REGRESSION (2026-09-05, 0.3.142): a real AskUserQuestion asked twice by the live
// orchestrator rendered NOTHING in Chat — no card, no chips — though status correctly went
// "blocked" (app-trace: "status: frame parsed=Some(\"blocked\")" for both asks). The hand-written
// stub above (`askTurn`, a single turn holding exactly one block) never exercised the shape a
// REAL transcript actually produces: Claude Code writes one JSONL row per content block (a
// `thinking` row, then a separate `tool_use` row, sharing one message id), and decode_chat_lines
// (lib.rs) turns each row into its OWN Turn — so a real backfill arrives as several consecutive
// single-block assistant turns, not one turn with several blocks. This fixture is exactly that
// shape: decoded (via the app's own decode_chat_lines_with_context_window) from the operator's
// own transcript lines 7280-7313 of
// ~/.claude/projects/-Users-sashabogojevic-development-trantor/2e1e3b96-ccf2-43a7-9ec5-4e5fe3f86acf.jsonl
// (an earlier Bash call, a thinking block, then the AskUserQuestion tool_use — the drill the
// operator ran to test 0.3.142 itself), truncated before the tool_result so the ask is still open.
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
    answerAtPane: async (target: string, data: string) => { answered.push({ target, data }); },
    Composer: () => null,
    TerminalPane: () => null,
  };
  return { deps, answered, traced };
}

describe("real transcript regression: an ask decoded the way the app actually decodes it (#6094 2026-09-05)", () => {
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

  it("renders the question card from a real multi-row backfill (thinking + tool_use as separate turns)", async () => {
    const { deps } = makeRealTranscriptDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    expect(host.textContent).toContain("On 0.3.142, did the card click");
    const buttons = [...host.querySelectorAll("button")].map(b => b.textContent ?? "");
    expect(buttons.some(t => t.includes("Yes, it answered"))).toBe(true);
  });

  it("shows chips for the same open ask", async () => {
    const { deps } = makeRealTranscriptDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    const chips = host.querySelector('[data-testid="suggestion-chips"]');
    expect(chips).not.toBeNull();
  });
});

// Same real-shape data, but delivered the way the LIVE app actually delivers it: Chat already
// mounted and idle (empty initial backfill), then the ask's rows arrive via "chat-rows" PUSH
// events (spawn_chat_watcher's 300ms file tail) in two batches — [Bash, thinking] then
// [AskUserQuestion] — followed by an "orch-status" push flipping status to blocked, exactly the
// order app-trace showed live (rows land before the status push, since the transcript write
// precedes herdr's own status flip). If the card only ever worked through the INITIAL backfill
// path (applyBackfill) and not the PUSH path (applyRows), this is where it would show.
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
      answerAtPane: async () => {},
      Composer: () => null,
      TerminalPane: () => null,
    };
    const fire = (event: string, payload: string) =>
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

    expect(host.textContent).toContain("On 0.3.142, did the card click");
    const buttons = [...host.querySelectorAll("button")].map(b => b.textContent ?? "");
    expect(buttons.some(t => t.includes("Yes, it answered"))).toBe(true);
    const chips = host.querySelector('[data-testid="suggestion-chips"]');
    expect(chips).not.toBeNull();
  });
});

// #6094 REGRESSION, root cause: two concurrent orchestrator_chat backfills. Chat's mount effect
// (line ~516) unconditionally calls sync() at the top and its OWN cleanup+re-run fires again the
// instant `target` resolves from null to a real pane surface (normal: the panel looks for a pane
// AFTER mounting, #5495) — so two sync() calls can be IN FLIGHT at once, BOTH dispatched while
// seenRef.current is still 0 (the second fires before the first's promise has resolved and moved
// the cursor). applyBackfill's own comment says a second answer "left after an earlier one landed
// is entirely subsumed by it" — true only if the second call was DISPATCHED after the first
// resolved. Here it was dispatched CONCURRENTLY with a stale after=0, and it happens to carry
// MORE rows (the orchestrator kept writing while both fetches were in flight) — exactly the
// live timeline: the ask was written seconds into the mount, while a second concurrent backfill
// was still settling. When that later-resolving, stale-`after` call finally lands, `s.seen`
// (already 29 from the first call) no longer matches its own captured `after` (0), so it takes
// the "heal the cursor" branch and BUMPS `seen` straight to the newer total — discarding the
// batch's `turns` entirely. The cursor now sits PAST the ask, so no future sync() ever re-fetches
// it: the ask is gone for good, exactly matching "nothing rendered, ever" (not a transient race).
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
    // sync()'s own busy-guard (added alongside the retry work) now collapses what used to be a
    // second genuinely concurrent dispatch into a deferred "pending" catch-up: the mount effect's
    // re-run (target null -> live pane, #5495) calls sync() again while the first call is still
    // in flight, but the guard just marks the want and returns immediately rather than reaching
    // the backend a second time. So only ONE call is ever manually held open; the catch-up that
    // fires once it resolves is the fix's own recovery re-sync — auto-answered immediately, from
    // wherever its `after` says the cursor actually sits, the way the real backend would.
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
      answerAtPane: async () => {},
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

    expect(host.textContent).toContain("On 0.3.142, did the card click");
  });
});

// #6094 REAL-PATH REGRESSION (2026-09-05, ask drill on 0.3.144): the ask drill proved the card
// path works once the surface is resolved and a blocked push arrives afterward — so the deeper
// bug is in the mount/unmount plumbing itself. In every real failure, app-trace showed: chat_watch
// generation 1, chat_unwatch, chat_watch generation 2 (an IMMEDIATE re-mount — target resolves
// from null to a live pane, #5495 — normal and expected), then herdr's blocked emit, then
// NOTHING from Chat. Root cause: the effect's cleanup used to read `watchGenerationRef.current`
// SYNCHRONOUSLY at cleanup time. If `target` resolves fast enough that generation 1's OWN
// chat_watch call has not resolved YET when its cleanup runs, that ref is still undefined, so
// cleanup sent chat_unwatch the generation-LESS fallback — which the Rust side (chat_watchers_unwatch,
// lib.rs) treats as "remove unconditionally, whatever is there", not "remove only if it's still
// generation 1". If generation 2's chat_watch had by then already installed its OWN watcher under
// the same key, this stale unconditional unwatch kills generation 2's Rust-side watcher too —
// leaving generation 2's "orch-status" listener registered but with no thread left to ever push
// it a frame: exactly the silence app-trace showed.
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
      answerAtPane: async () => {},
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

    // Generation 2 (the live one) answers first, exactly as app-trace showed in the real failure.
    act(() => { watchResolvers[1]({ current: 0, generation: 2 }); });
    await flush();
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

// #6094 REAL-PATH REGRESSION, third round (0.3.145, 09-05 19:27): the watcher fix (4c3b0db) held
// — generations were correct — and the card STILL did not render. app-trace named the mechanism
// exactly: "chat blocked with no open ask: ... turns=724 seen=8096" fired at the SAME moment
// herdr's blocked frame arrived, but the AskUserQuestion tool_use was three transcript lines
// AHEAD of Chat's cursor — the CLI writes the tool_use row a moment AFTER herdr reports blocked,
// so a single look-and-give-up at the blocked instant finds nothing and never looks again. This
// mounts Chat idle (no ask anywhere in the transcript yet), pushes blocked, and only THEN makes
// the transcript's next backfill answer carry the ask — proving Chat re-syncs on its own instead
// of waiting for a push that, in this exact race, never arrives in time.
describe("blocked-with-no-open-ask retries the backfill instead of giving up once (#6094, 2026-09-05)", () => {
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

  it("the ask card appears within the retry window even though the ask post-dates the blocked push", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, Handler[]>();
      let askWritten = false;
      const deps: ChatDeps = {
        invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
          if (cmd === "orchestrator_chat") {
            // SAFETY: Chat always calls orchestrator_chat with a plain `{ after: number }` object.
            const after = (args as { after: number } | undefined)?.after ?? 0;
            // Before the CLI "writes" the ask: line 0 carries an ordinary user turn, cursor at 1.
            // After: a second backfill from the same cursor carries the ask, cursor at 2 — the
            // CLI having appended exactly the one row app-trace showed Chat was behind on.
            const backfill = after === 0
              ? [[{ role: "user", blocks: [{ kind: "text", text: "check", tool: null, tool_id: null }] }], [], 1, REAL_ASK_META, ["check"]]
              : askWritten
                ? [[askTurn], [], 2, REAL_ASK_META, []]
                : [[], [], after, REAL_ASK_META, []];
            // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is
            // exactly the Backfill shape built above.
            return Promise.resolve(JSON.stringify(backfill) as T);
          }
          if (cmd === "chat_watch") {
            // SAFETY: Chat types this call Promise<ChatWatchResult> — current=1 matches the
            // pre-ask backfill's own total.
            return Promise.resolve({ current: 1, generation: 1 } as T);
          }
          if (cmd === "orchestrator_status") {
            // SAFETY: Chat types this call Promise<string>; the pane starts "working" — blocked
            // arrives later via the orch-status push under test.
            return Promise.resolve("working" as T);
          }
          // SAFETY: unknown commands (app_log included) resolve to null, matching the real
          // seam's unhandled default — this test asserts on DOM state, not trace content.
          return Promise.resolve(null as T);
        },
        listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
          // SAFETY: the handler is stored under the unknown-payload container (Handler, above)
          // and fired with exactly what listen delivered — this test only fires "orch-status".
          const boxed = cb as Handler;
          handlers.set(event, [...(handlers.get(event) ?? []), boxed]);
          return Promise.resolve(() => {});
        },
        orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
        answerAtPane: async () => {},
        Composer: () => null,
        TerminalPane: () => null,
      };

      act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

      // herdr reports blocked BEFORE the tool_use row exists in the transcript — exactly the
      // observed real-path ordering.
      await act(async () => {
        for (const cb of handlers.get("orch-status") ?? []) cb({ payload: JSON.stringify({ project: "p", status: "blocked" }) });
        await Promise.resolve();
      });
      expect(host.querySelector('[data-testid="ask-card"]')).toBeNull();

      // The CLI finishes writing the ask a moment later.
      askWritten = true;

      // Advance past the first fast-retry tick and let its sync() settle.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FAST_RETRY_MS + 50);
      });

      expect(host.querySelector('[data-testid="ask-card"]')).not.toBeNull();
      expect(host.textContent).toContain("Ship it?");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the retry window — proves the retry is bounded, not a permanent poll", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, Handler[]>();
      const chatWatchCalls: unknown[] = [];
      const deps: ChatDeps = {
        invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
          if (cmd === "orchestrator_chat") {
            // SAFETY: Chat always calls orchestrator_chat with a plain `{ after: number }` object.
            const after = (args as { after: number } | undefined)?.after ?? 0;
            chatWatchCalls.push(after);
            // The ask never arrives in this scenario — a genuinely different, non-ask block.
            // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is
            // an empty Backfill advancing only the cursor.
            return Promise.resolve(JSON.stringify([[], [], after, REAL_ASK_META, []]) as T);
          }
          if (cmd === "chat_watch") {
            // SAFETY: Chat types this call Promise<ChatWatchResult>; the exact values are never
            // asserted on here, only that chat_watch succeeds so the retry effect can run.
            return Promise.resolve({ current: 0, generation: 1 } as T);
          }
          if (cmd === "orchestrator_status") {
            // SAFETY: Chat types this call Promise<string>; the pane starts "working" — blocked
            // arrives later via the orch-status push under test.
            return Promise.resolve("working" as T);
          }
          // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
          return Promise.resolve(null as T);
        },
        listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
          // SAFETY: the handler is stored under the unknown-payload container (Handler, above)
          // and fired with exactly what listen delivered — this test only fires "orch-status".
          const boxed = cb as Handler;
          handlers.set(event, [...(handlers.get(event) ?? []), boxed]);
          return Promise.resolve(() => {});
        },
        orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
        answerAtPane: async () => {},
        Composer: () => null,
        TerminalPane: () => null,
      };

      act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        for (const cb of handlers.get("orch-status") ?? []) cb({ payload: JSON.stringify({ project: "p", status: "blocked" }) });
        await Promise.resolve();
      });

      const callsSoFar = chatWatchCalls.length;
      // Past the fast window, then the slow window, then well beyond both.
      await act(async () => { await vi.advanceTimersByTimeAsync(FAST_RETRY_WINDOW_MS + 6_000 + 5_000); });
      const callsAfter = chatWatchCalls.length;
      expect(callsAfter).toBeGreaterThan(callsSoFar);

      // Silence past the retry window: no ask ever appeared, and the retries stopped.
      const settledCalls = chatWatchCalls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(chatWatchCalls.length).toBe(settledCalls);
      expect(host.querySelector('[data-testid="ask-card"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// #6094 REAL-PATH REGRESSION, fourth round (0.3.146, 09-05 19:41): retries ran 15 times over 8s
// and NEVER found an ask that had been on disk for 31+ real seconds. A Rust test proved the
// decode path itself returns a trailing open ask correctly even with no closing user line (this
// PASSES on main — the withholding theory was wrong), so the actual defect had to be in the
// retry loop itself: it called sync() and scheduled the NEXT retry via a bare setTimeout WITHOUT
// awaiting sync()'s own promise. A real transcript that size takes read_chat_snapshot longer than
// FAST_RETRY_MS to decode (it walks the whole file twice — once for meta, once for the actual
// snapshot), so the next retry dispatched before the previous one resolved, both captured with
// the same stale cursor — the exact concurrent-backfill race sync() itself guards against
// (1c6e75f), self-inflicted by the retry loop this time: every reply lands looking "stale"
// against whatever dispatched after it and just re-triggers ANOTHER sync(), forever, without
// ever reaching the success path that absorbs a batch. This proves retries never overlap even
// when the backend is slower than the retry interval.
describe("blocked-no-ask retries never overlap, even when the backfill answers slower than the retry interval (#6094, 2026-09-05)", () => {
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

  it("never dispatches a second orchestrator_chat call before the first resolves, and still finds the ask once it lands", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, Handler[]>();
      let inFlight = 0;
      let maxInFlight = 0;
      let askWritten = false;
      // Slower than FAST_RETRY_MS (300ms) — a real transcript large enough to matter.
      const BACKEND_LATENCY_MS = 500;

      const deps: ChatDeps = {
        invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
          if (cmd === "orchestrator_chat") {
            // SAFETY: Chat always calls orchestrator_chat with a plain `{ after: number }` object.
            const after = (args as { after: number } | undefined)?.after ?? 0;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            // The ask is new data exactly once (the first call to see after===1 with askWritten
            // true) — every OTHER call, including any later catch-up dispatched by sync()'s own
            // pending-flag mechanism, must answer "nothing new past your own cursor" or it
            // re-absorbs the same ask turn repeatedly: `absorb()` appends `fresh` turns
            // unconditionally, so a backend that repeats a row it already reported piles up
            // duplicate assistant turns that `group()`/`batch()` then collapse into a "N tools"
            // summary row instead of the single-block card — a real backend never repeats a line.
            const backfill = after === 0
              ? [[{ role: "user", blocks: [{ kind: "text", text: "check", tool: null, tool_id: null }] }], [], 1, REAL_ASK_META, ["check"]]
              : after === 1 && askWritten
                ? [[askTurn], [], 2, REAL_ASK_META, []]
                : [[], [], Math.max(after, askWritten ? 2 : after), REAL_ASK_META, []];
            // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is
            // exactly the Backfill shape built above.
            return new Promise<string>(resolve => {
              setTimeout(() => { inFlight -= 1; resolve(JSON.stringify(backfill)); }, BACKEND_LATENCY_MS);
            }) as Promise<T>;
          }
          if (cmd === "chat_watch") {
            // SAFETY: Chat types this call Promise<ChatWatchResult> — current=1 matches the
            // pre-ask backfill's own total.
            return Promise.resolve({ current: 1, generation: 1 } as T);
          }
          if (cmd === "orchestrator_status") {
            // SAFETY: Chat types this call Promise<string>; the pane starts "working" — blocked
            // arrives later via the orch-status push under test.
            return Promise.resolve("working" as T);
          }
          // SAFETY: unknown commands (app_log included) resolve to null, matching the real
          // seam's unhandled default.
          return Promise.resolve(null as T);
        },
        listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
          // SAFETY: the handler is stored under the unknown-payload container (Handler, above)
          // and fired with exactly what listen delivered — this test only fires "orch-status".
          const boxed = cb as Handler;
          handlers.set(event, [...(handlers.get(event) ?? []), boxed]);
          return Promise.resolve(() => {});
        },
        orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
        answerAtPane: async () => {},
        Composer: () => null,
        TerminalPane: () => null,
      };

      // Set from the start: this test is purely about CONCURRENCY (never two calls in flight at
      // once, whatever the source), not about the ask arriving late — that race is the OTHER
      // test's job. Flipping this mid-test would race the mount-time dispatch's own capture of
      // it against real (fake-clock) time, which is a test-harness timing accident, not the
      // production behavior under test here.
      askWritten = true;

      act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
      // Let mount settle fully first: the mount effect's OWN unconditional sync() and its
      // "watch.current > seenRef.current" gap-check can each dispatch once around t=0 — a
      // harmless, pre-existing duplicate the 1c6e75f mismatch guard already resolves without
      // consequence, PLUS sync()'s own busy-guard now collapses genuine overlaps into a deferred
      // catch-up instead of a second real dispatch. Only the RETRY LOOP's own overlap behavior is
      // under test here, so maxInFlight starts counting fresh once mount-time activity is done.
      await act(async () => { await vi.advanceTimersByTimeAsync(BACKEND_LATENCY_MS + 50); });
      maxInFlight = 0;

      await act(async () => {
        for (const cb of handlers.get("orch-status") ?? []) cb({ payload: JSON.stringify({ project: "p", status: "blocked" }) });
        await Promise.resolve();
      });

      // Run several retry ticks' worth of fake time — under the bug, this alone piles up
      // overlapping dispatches since each tick used to fire every FAST_RETRY_MS regardless of
      // whether the previous call had resolved.
      await act(async () => { await vi.advanceTimersByTimeAsync(FAST_RETRY_MS * 6); });

      expect(maxInFlight).toBe(1);
      expect(host.querySelector('[data-testid="ask-card"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// #6094, 0.3.148/0.3.149 real-path bounce: the live push emitted "ok=true" on the Rust side
// (confirmed via app-trace), with NOT ONE "chat status ...: push=..." line following it — the
// listener's own silent `catch {}` and silent "project didn't match" fall-through were both
// indistinguishable from "the event never arrived at all", leaving zero evidence for the one
// push that mattered. This proves every arrival now traces itself, naming which of the outcomes
// happened instead of vanishing silently.
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
      answerAtPane: async () => {},
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

// #6094 root cause (2026-09-05, 0.3.149 real-panel drill): decodeOrchStatus (edc9558) fixed the
// listener, so a live blocked push now commits status and openQuestion() DOES find the ask in
// chat.turns — no "blocked with no open ask" trace fires, exactly what the operator saw. Yet no
// card appeared. batch() (line ~61) groups every CONSECUTIVE `kind: "tool"` block into one array,
// and ToolRun collapses any array longer than 1 behind a closed-by-default "N tools" toggle. The
// REAL_ASK_TURNS fixture above never hit this: a `thinking` block sits between the Bash call and
// the AskUserQuestion, breaking the run into two singletons. A turn where a tool call is followed
// DIRECTLY by an AskUserQuestion — no thinking, no text in between, the shape an orchestrator
// produces when it checks something and then asks in the same breath — batches them into ONE
// array of length 2, and the ask (the one thing in the transcript the operator must act on) hides
// behind a collapsed bar reading "2 tools" until someone thinks to click it open.
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
const ADJACENT_ASK_RESULTS = [{ tool_id: "toolu_bash1", ok: true, preview: "nothing to commit" }];

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

  it("still renders the ask card, not a collapsed \"2 tools\" toggle", async () => {
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
      answerAtPane: async () => {},
      Composer: () => null,
      TerminalPane: () => null,
    };

    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();

    expect(host.querySelector('[data-testid="ask-card"]')).not.toBeNull();
    expect(host.textContent).toContain("Push now?");
    const buttons = [...host.querySelectorAll("button")].map(b => b.textContent ?? "");
    expect(buttons.some(t => t.includes("Yes"))).toBe(true);
  });
});
