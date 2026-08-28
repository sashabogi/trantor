import { describe, expect, it } from "vitest";
import {
  applyBackfill, applyRows, applySessionChanged, emptyChat,
  sessionLiveness, type Backfill, type ChatState, type RowsPayload,
} from "./streaming";

const t = (text: string) => ({ role: "user" as const, blocks: [{ kind: "text" as const, text }] });
const r = (tool_id: string, ok = true) => ({ tool_id, ok, preview: `out ${tool_id}` });

function rows(after: number, turns: RowsPayload["turns"], extra: Partial<RowsPayload> = {}): RowsPayload {
  return { project: "p", sessionId: "s1", after, turns, results: [], meta: { model: "", version: "", branch: "" }, ...extra };
}

describe("applyRows", () => {
  it("appends an in-order batch and advances the cursor by its rows", () => {
    const s = { ...emptyChat, seen: 10 };
    const { state, resync } = applyRows(s, rows(10, [t("hello")]));
    expect(resync).toBe(false);
    expect(state.turns).toEqual([t("hello")]);
    expect(state.seen).toBe(11);
  });

  it("discards a batch whose after misses the cursor — no gap is ever guessed shut", () => {
    const s = { ...emptyChat, seen: 12 };
    const { state, resync } = applyRows(s, rows(10, [t("stale")]));
    expect(resync).toBe(true);
    expect(state).toBe(s);
  });

  it("discards a batch that starts PAST the cursor — a skipped batch is also a mismatch", () => {
    const s = { ...emptyChat, seen: 10 };
    const { state, resync } = applyRows(s, rows(14, [t("future")]));
    expect(resync).toBe(true);
    expect(state).toBe(s);
  });

  it("takes the watcher's total as the exact cursor when it offers one", () => {
    const s = { ...emptyChat, seen: 10 };
    // A batch of 2 rows covering 3 lines (one was a tool_result line): turns.length would guess 12.
    const { state } = applyRows(s, rows(10, [t("a"), t("b")], { total: 13 }));
    expect(state.seen).toBe(13);
  });

  it("merges results by tool id so a card fills in when its answer lands", () => {
    const s = { ...emptyChat, seen: 0 };
    const { state } = applyRows(s, rows(0, [], { results: [r("t1", false)] }));
    expect(state.results.t1).toEqual({ tool_id: "t1", ok: false, preview: "out t1" });
    expect(state.turns).toEqual([]);
  });

  it("absorbs meta so a model switch shows as soon as its row lands", () => {
    const s: ChatState = { ...emptyChat, seen: 5, meta: { model: "old", version: "1", branch: "main" } };
    const { state } = applyRows(s, rows(5, [], { meta: { model: "new", version: "", branch: "" } }));
    expect(state.meta.model).toBe("new");
  });
});

describe("applyBackfill", () => {
  it("appends the fetch, merges results, and anchors the cursor to the authoritative total", () => {
    const s = { ...emptyChat, seen: 3 };
    const b: Backfill = [[t("a")], [r("t9")], 7, { model: "m", version: "9", branch: "main" }];
    const state = applyBackfill(s, b, 3);
    expect(state.turns).toEqual([t("a")]);
    expect(state.results.t9).toBeDefined();
    expect(state.seen).toBe(7);
    expect(state.meta).toEqual({ model: "m", version: "9", branch: "main" });
  });

  it("drops a stacked fetch whose rows an earlier answer already covered — no duplicates", () => {
    const first = applyBackfill({ ...emptyChat, seen: 3 }, [[t("a")], [], 7, emptyChat.meta], 3);
    // Same fetch left twice; the second lands after the first applied.
    const second = applyBackfill(first, [[t("a")], [], 7, emptyChat.meta], 3);
    expect(second.turns).toEqual([t("a")]);
    expect(second.seen).toBe(7);
  });

  it("keeps a continued marker across a plain backfill", () => {
    const s = { ...emptyChat, seen: 0, continued: true };
    expect(applyBackfill(s, [[t("x")], [], 1, emptyChat.meta], 0).continued).toBe(true);
  });
});

describe("applySessionChanged", () => {
  it("clears the thread and results, restarts the cursor at 0, and raises the divider flag", () => {
    const s: ChatState = {
      turns: [t("old")], results: { t1: r("t1") }, seen: 40,
      meta: { model: "m", version: "1", branch: "main" }, continued: false,
    };
    const state = applySessionChanged(s);
    expect(state.turns).toEqual([]);
    expect(state.results).toEqual({});
    expect(state.seen).toBe(0);
    expect(state.meta).toEqual(emptyChat.meta);
    expect(state.continued).toBe(true);
  });

  it("lets the new session's rows apply from 0 afterwards", () => {
    const state = applyRows(applySessionChanged({ ...emptyChat, seen: 40 }), rows(0, [t("fresh")]));
    expect(state.resync).toBe(false);
    expect(state.state.turns).toEqual([t("fresh")]);
    expect(state.state.seen).toBe(1);
  });
});

describe("sessionLiveness (#5477)", () => {
  it("is not live when no pane is hosted", () => {
    const v = sessionLiveness("none", null);
    expect(v.live).toBe(false);
    expect(v.why).toContain("Workspace lens");
  });

  it("is not live when the pane exists but herdr reports no agent behind it", () => {
    const v = sessionLiveness("unknown", "w2:pB");
    expect(v.live).toBe(false);
    expect(v.why).toContain("not running an agent");
  });

  it("is not live when a pane is registered but the status says no session", () => {
    expect(sessionLiveness("none", "w2:pB").live).toBe(false);
  });

  it("is live for every status herdr vouches for — working, idle, and ones we have not met", () => {
    expect(sessionLiveness("working", "w2:pB").live).toBe(true);
    expect(sessionLiveness("idle", "w2:pB").live).toBe(true);
    expect(sessionLiveness("starting", "w2:pB").live).toBe(true);
  });
});
