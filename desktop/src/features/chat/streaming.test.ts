import { describe, expect, it } from "vitest";
import {
  applyBackfill, applyRows, applySessionChanged, bannerVisible, composerSlot, emptyChat,
  gaugeLabel, gaugeTone, gaugeUnknownWindow, insertPaths, isDividerTurn,
  sessionLiveness, receiptFor, LOST_AFTER_MS, HANDOFF_WARN_FRAC,
  elapsedShort, lastToolLabel, tickerText,
  type Backfill, type ChatState, type ContextGauge, type Meta, type RowsPayload, type Turn,
} from "./streaming";

const t = (text: string) => ({ role: "user" as const, blocks: [{ kind: "text" as const, text }] });
const r = (tool_id: string, ok = true) => ({ tool_id, ok, preview: `out ${tool_id}` });
const CTX0 = (): ContextGauge => ({ tokens: null, window: 0, frac: null });
const meta = (m: Partial<Meta> = {}): Meta => ({ model: "", version: "", branch: "", context: CTX0(), ...m });

function rows(after: number, turns: RowsPayload["turns"], extra: Partial<RowsPayload> = {}): RowsPayload {
  return { project: "p", sessionId: "s1", after, turns, results: [], meta: meta(), ...extra };
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
    const s: ChatState = { ...emptyChat, seen: 5, meta: meta({ model: "old", version: "1", branch: "main" }) };
    const { state } = applyRows(s, rows(5, [], { meta: meta({ model: "new" }) }));
    expect(state.meta.model).toBe("new");
  });

  it("carries the context gauge through a batch so the bar moves as rows land (#5508)", () => {
    const s = { ...emptyChat, seen: 5 };
    const { state } = applyRows(s, rows(5, [], { meta: meta({ context: { tokens: 489_000, window: 1_000_000, frac: 0.489 } }) }));
    expect(state.meta.context).toEqual({ tokens: 489_000, window: 1_000_000, frac: 0.489 });
  });
});

describe("applyBackfill", () => {
  it("appends the fetch, merges results, and anchors the cursor to the authoritative total", () => {
    const s = { ...emptyChat, seen: 3 };
    const b: Backfill = [[t("a")], [r("t9")], 7, meta({ model: "m", version: "9", branch: "main" })];
    const state = applyBackfill(s, b, 3);
    expect(state.turns).toEqual([t("a")]);
    expect(state.results.t9).toBeDefined();
    expect(state.seen).toBe(7);
    expect(state.meta.model).toBe("m");
    expect(state.meta.version).toBe("9");
    expect(state.meta.branch).toBe("main");
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
   it("preserves the predecessor thread above a divider turn", () => {
     const s: ChatState = {
       turns: [t("old")], results: { t1: r("t1") }, receiptTexts: ["old"], seen: 40,
       meta: meta({ model: "m", version: "1", branch: "main" }), continued: false,
     };
     const state = applySessionChanged(s);
     expect(state.turns).toHaveLength(2);
     expect(state.turns[0]).toEqual(t("old"));
     expect(state.turns[1]).toEqual({ role: "system" as const, blocks: [{ kind: "divider" as const, text: "session continued" }] });
     expect(state.results).toEqual({ t1: r("t1") });
     expect(state.receiptTexts).toEqual(["old"]);
     expect(state.seen).toBe(0);
     expect(state.meta).toEqual(s.meta);
     expect(state.continued).toBe(true);
   });

   it("inserts a divider turn-list item the successor can detect via isDividerTurn", () => {
     const s = { ...emptyChat, turns: [t("predecessor")] };
     const state = applySessionChanged(s);
     expect(isDividerTurn(state.turns[1])).toBe(true);
   });

   it("lets the new session's rows apply from 0 afterwards", () => {
     const state = applyRows(applySessionChanged({ ...emptyChat, seen: 40 }), rows(0, [t("fresh")]));
     expect(state.resync).toBe(false);
      expect(state.state.turns).toEqual([{ role: "system" as const, blocks: [{ kind: "divider" as const, text: "session continued" }] }, t("fresh")]);
     expect(state.state.seen).toBe(1);
   });

   it("retains the predecessor's results so the successor can pull its tail", () => {
     const s: ChatState = {
       turns: [t("old")], results: { t1: r("t1", true), t2: r("t2", false) },
       receiptTexts: [], seen: 10, meta: meta(), continued: false,
     };
     const state = applySessionChanged(s);
     expect(state.results.t1.ok).toBe(true);
     expect(state.results.t2.ok).toBe(false);
   });

   it("clears only seen and resets the cursor — predecessor data is retained", () => {
     const s = { ...emptyChat, seen: 40, receiptTexts: ["stale"], results: { t1: r("t1") } };
     const state = applySessionChanged(s);
     expect(state.seen).toBe(0);
     expect(state.receiptTexts).toEqual(["stale"]);
     expect(state.results.t1).toBeDefined();
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

// #5504 — sending is not delivery; the transcript is the only truth about arrival.
describe("receiptFor", () => {
  const at = 1_000_000;

  it("delivers when a user turn echoes the text exactly", () => {
    expect(receiptFor({ text: "hello there", at }, ["hello there"], at + 100)).toBe("delivered");
  });

  it("delivers on CONTAINMENT — a row fused with staged input is delivered, just dirty", () => {
    expect(receiptFor({ text: "tell me how we proceed", at }, ["/compact tell me how we proceed"], at + 100)).toBe("delivered");
  });

  it("stays sending inside the window while nothing echoes", () => {
    expect(receiptFor({ text: "x", at }, [], at + LOST_AFTER_MS - 1)).toBe("sending");
  });

  it("declares LOST once the window closes with no echo — never silently", () => {
    expect(receiptFor({ text: "x", at }, ["unrelated"], at + LOST_AFTER_MS + 1)).toBe("lost");
  });

  it("an empty send can never claim delivery off an unrelated row", () => {
    expect(receiptFor({ text: "", at }, ["anything"], at + 100)).toBe("sending");
  });

  it("a dropped image path (trailing space by design, #5507) matches its [Image: source:] row", () => {
    // The 2026-08-30 false alarm: single screenshot dropped, path + trailing space sent,
    // transcript recorded "[Image: source: <path>]" — path followed by "]", not by a space.
    const p = "/Users/x/Library/Application Support/CleanShot/media/m_1/CleanShot 2026-08-30 at 18.18.39.jpg";
    expect(receiptFor({ text: `${p} `, at }, [`[Image: source: ${p}]`], at + 100)).toBe("delivered");
    expect(receiptFor({ text: `${p} `, at }, ["[Image: source: /some/other.jpg]"], at + LOST_AFTER_MS + 1)).toBe("lost");
  });

  it("a whitespace-only send never claims delivery", () => {
    expect(receiptFor({ text: "   ", at }, ["anything"], at + 100)).toBe("sending");
  });

  it("image + Shift-Enter prose delivers LINE-WISE — the CLI splits them into separate blocks", () => {
    // The third receipt gap (2026-08-30): path line became an image block, prose its own text
    // block; the full draft never exists as one string again.
    const draft = "/Users/x/CleanShot 2026-08-30 at 18.53.25.jpg \nGo ahead, but also one of the bigger annoyances";
    const turns = ["[Image: source: /Users/x/CleanShot 2026-08-30 at 18.53.25.jpg]", "Go ahead, but also one of the bigger annoyances that I have"];
    expect(receiptFor({ text: draft, at }, turns, at + 100)).toBe("delivered");
  });

  it("line-wise never claims delivery while a line is still missing", () => {
    const draft = "/Users/x/shot.jpg \nthe words that were eaten";
    expect(receiptFor({ text: draft, at }, ["[Image: source: /Users/x/shot.jpg]"], at + LOST_AFTER_MS + 1)).toBe("lost");
  });

  it("a PATHLESS placeholder stands in for a dropped path — gap four (2026-08-30)", () => {
    // One two-image turn produced BOTH shapes: '[Image #13]' (path vanished into a binary
    // block) and '[Image: source: <path>]'. Each path line may consume one placeholder.
    expect(receiptFor({ text: "/Users/x/a b/shot one.jpg ", at }, ["[Image #13]look at this"], at + 100)).toBe("delivered");
    const two = "/Users/x/first.jpg \n/Users/x/second one.jpg ";
    expect(receiptFor({ text: two, at }, ["[Image #1][Image: source: /Users/x/second one.jpg]"], at + 100)).toBe("delivered");
  });

  it("the placeholder BUDGET keeps it honest — two paths, one marker, no source record → lost", () => {
    const two = "/Users/x/first.jpg \n/Users/x/second.jpg ";
    expect(receiptFor({ text: two, at }, ["[Image #1] some prose"], at + LOST_AFTER_MS + 1)).toBe("lost");
  });

  it("a prose line can never ride a placeholder — only paths may", () => {
    expect(receiptFor({ text: "words that never arrived", at }, ["[Image #1]"], at + LOST_AFTER_MS + 1)).toBe("lost");
  });
});

// #5508 — the gauge tells the truth about a filling window, and stays absent until it knows one.
describe("gaugeUnknownWindow", () => {
  it("flags tokens-without-window (#5503, the fable case) and nothing else", () => {
    expect(gaugeUnknownWindow({ tokens: 392607, window: 0, frac: null })).toBe(true);
    expect(gaugeUnknownWindow({ tokens: 392607, window: 1000000, frac: 0.39 })).toBe(false);
    expect(gaugeUnknownWindow({ tokens: null, window: 0, frac: null })).toBe(false);
    expect(gaugeUnknownWindow({ tokens: 0, window: 0, frac: null })).toBe(false);
  });
});

describe("gaugeTone", () => {
  it("is hidden while frac is unknown — no usage row seen yet", () => {
    expect(gaugeTone(null)).toBe("hidden");
  });

  it("neutral strictly below 0.75", () => {
    expect(gaugeTone(0)).toBe("neutral");
    expect(gaugeTone(0.749)).toBe("neutral");
  });

  it("amber AT 0.75 and up to (not including) 0.90", () => {
    expect(gaugeTone(0.75)).toBe("amber");
    expect(gaugeTone(0.899)).toBe("amber");
  });

  it("red AT 0.90 and past it — an overflowed window is still red", () => {
    expect(gaugeTone(0.90)).toBe("red");
    expect(gaugeTone(1)).toBe("red");
    expect(gaugeTone(1.2)).toBe("red");
  });
});

describe("gaugeLabel", () => {
  it("formats the tooltip exactly as the contract writes it: 489k / 1000k (49%)", () => {
    expect(gaugeLabel({ tokens: 489_000, window: 1_000_000, frac: 0.489 })).toBe("489k / 1000k (49%)");
  });

  it("rounds to whole k rather than truncating — 999_600 reads 1000k", () => {
    expect(gaugeLabel({ tokens: 999_600, window: 1_000_000, frac: 0.9996 })).toBe("1000k / 1000k (100%)");
  });
});

// #5502 — bookkeeping never wears the user's face: divider material renders as a divider, and
// real speech NEVER does.
describe("isDividerTurn", () => {
  const divider = (text: string): Turn => ({ role: "system", blocks: [{ kind: "divider", text }] });

  it("a system turn with divider blocks is a divider", () => {
    expect(isDividerTurn(divider("/compact"))).toBe(true);
  });

  it("a plain user speech turn stays speech — never a divider", () => {
    expect(isDividerTurn(t("drop a screenshot into the chat"))).toBe(false);
    expect(isDividerTurn({ role: "assistant", blocks: [{ kind: "text", text: "on it" }] })).toBe(false);
  });

  it("a divider BLOCK stays a divider even outside a system turn — the block kind is the verdict", () => {
    expect(isDividerTurn({ role: "user", blocks: [{ kind: "divider", text: "<local-command-caveat>" }] })).toBe(true);
  });
});

// #5507 — dropped paths splice into the draft at the caret, exactly like the @-accept.
describe("insertPaths", () => {
  it("inserts each absolute path plus a trailing space into an empty draft", () => {
    expect(insertPaths("", 0, ["/Users/s/shot.png"])).toBe("/Users/s/shot.png ");
  });

  it("splices at the cursor and keeps whatever followed it", () => {
    expect(insertPaths("see this", 3, ["/tmp/a.png", "/tmp/b.png"])).toBe("see/tmp/a.png /tmp/b.png  this");
  });

  it("appends at the end when the cursor sits past the last character", () => {
    expect(insertPaths("look at ", 8, ["/tmp/x.png"])).toBe("look at /tmp/x.png ");
  });

  it("an empty drop is a no-op splice", () => {
    expect(insertPaths("unchanged", 4, [])).toBe("unchanged");
  });
});

// Three delivery states (sent, queued, seen) — the chat's claim must match the terminal's queue.
describe("queued turns and dequeue markers", () => {
  const qt = (text: string): Turn => ({ role: "user", blocks: [{ kind: "text", text }], queued: true });
  const dq = (text: string): Turn => ({ role: "system", blocks: [{ kind: "dequeue", text }] });

  it("a queued turn arrives wearing its flag", () => {
    const { state } = applyRows({ ...emptyChat, seen: 0 }, rows(0, [qt("while busy")]));
    expect(state.turns[0].queued).toBe(true);
  });

  it("a later dequeue marker clears the flag and never renders", () => {
    const first = applyRows({ ...emptyChat, seen: 0 }, rows(0, [qt("while busy")])).state;
    const { state } = applyRows(first, rows(1, [dq("while busy")]));
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].queued).toBeUndefined();
  });

  it("enqueue and dequeue in ONE batch net a seen turn", () => {
    const { state } = applyRows({ ...emptyChat, seen: 0 }, rows(0, [qt("fast"), dq("fast")]));
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].queued).toBeUndefined();
  });

  it("a marker with no matching queued turn is dropped harmlessly", () => {
    const { state } = applyRows({ ...emptyChat, seen: 0 }, rows(0, [t("plain"), dq("never enqueued")]));
    expect(state.turns).toEqual([t("plain")]);
  });

  it("the NEWEST matching queued turn is the one cleared", () => {
    const s1 = applyRows({ ...emptyChat, seen: 0 }, rows(0, [qt("same words")])).state;
    const s2 = applyRows(s1, rows(1, [qt("same words")])).state;
    const { state } = applyRows(s2, rows(2, [dq("same words")]));
    expect(state.turns[0].queued).toBe(true);
    expect(state.turns[1].queued).toBeUndefined();
  });
});

describe("bannerVisible (#5509 W1)", () => {
  it("shows from exactly the gauge's red threshold — unknown frac never shows", () => {
    expect(gaugeTone(HANDOFF_WARN_FRAC)).toBe("red");
    expect(bannerVisible(null, null)).toBe(false);
    expect(bannerVisible(0.899, null)).toBe(false);
    expect(bannerVisible(HANDOFF_WARN_FRAC, null)).toBe(true);
    expect(bannerVisible(1, null)).toBe(true);
  });

  it("a keep-going parks the offer while frac stays within one step of the dismissal", () => {
    expect(bannerVisible(0.9, 0.9)).toBe(false);
    expect(bannerVisible(0.91, 0.9)).toBe(false);
    expect(bannerVisible(0.919, 0.9)).toBe(false);
  });

  it("re-offers exactly at dismissal + 0.02 — an episode of growth, not a timer", () => {
    expect(bannerVisible(0.92, 0.9)).toBe(true);
    expect(bannerVisible(0.97, 0.95)).toBe(true);
  });

  it("below the warning band there is nothing to offer, dismissed or not", () => {
    expect(bannerVisible(0.5, null)).toBe(false);
    expect(bannerVisible(0.5, 0.9)).toBe(false);
  });

  it("a stale dismissal from below the band never muzzles the first qualifying arrival", () => {
    expect(bannerVisible(0.9, 0.5)).toBe(true);
  });
});

describe("composerSlot (#5556)", () => {
  it("while the agent works the slot is STOP — and interrupting is never gated", () => {
    // Not by liveness, not by an empty draft, not by a send in flight: a working turn is its own
    // proof there is something to interrupt.
    expect(composerSlot(true, true, "hello", false)).toEqual({ kind: "stop" });
    expect(composerSlot(true, false, "", true)).toEqual({ kind: "stop" });
  });

  it("otherwise the slot is SEND, enabled only when live, not busy, and the draft has words", () => {
    expect(composerSlot(false, true, "hello", false)).toEqual({ kind: "send", disabled: false });
    expect(composerSlot(false, false, "hello", false)).toEqual({ kind: "send", disabled: true });
    expect(composerSlot(false, true, "hello", true)).toEqual({ kind: "send", disabled: true });
  });

  it("a draft of whitespace is a draft of nothing — trim decides, not length", () => {
    expect(composerSlot(false, true, "", false)).toEqual({ kind: "send", disabled: true });
    expect(composerSlot(false, true, "   \n\t ", false)).toEqual({ kind: "send", disabled: true });
    expect(composerSlot(false, true, " x ", false)).toEqual({ kind: "send", disabled: false });
  });
});


// #5608 — the live turn ticker: the app must never look dead while a turn chews.
describe("turn ticker", () => {
  const toolTurn = (tool: string, text: string): Turn =>
    ({ role: "assistant", blocks: [{ kind: "tool", text, tool, tool_id: "t1" }] });

  it("working reads elapsed · tool · context", () => {
    expect(tickerText("working", 252_000, "Bash(cargo test)", 391_000))
      .toBe("working · 4m 12s · Bash(cargo test) · 391k ctx");
  });

  it("blocked names the wait and drops the tool — nothing is running", () => {
    expect(tickerText("blocked", 8_000, "Bash(x)", 391_000))
      .toBe("blocked — waiting on an approval · 8s · 391k ctx");
  });

  it("idle and none say NOTHING — absence is the idle state", () => {
    expect(tickerText("idle", 1000, "Bash(x)", 391_000)).toBe(null);
    expect(tickerText("none", null, null, null)).toBe(null);
  });

  it("unknown elapsed and tokens simply drop out", () => {
    expect(tickerText("working", null, "Read(lib.rs)", null)).toBe("working · Read(lib.rs)");
  });

  it("lastToolLabel finds the newest tool and trims its argument to a whiff", () => {
    const turns: Turn[] = [
      toolTurn("Read", "old.rs"),
      { role: "user", blocks: [{ kind: "text", text: "go" }] },
      toolTurn("Bash", "  cargo   test --all " + "x".repeat(60)),
    ];
    const label = lastToolLabel(turns)!;
    expect(label.startsWith("Bash(cargo test --all")).toBe(true);
    expect(label.endsWith("…)")).toBe(true);
    expect(lastToolLabel([{ role: "user", blocks: [{ kind: "text", text: "hi" }] }])).toBe(null);
  });

  it("elapsedShort steps through its units", () => {
    expect(elapsedShort(8_000)).toBe("8s");
    expect(elapsedShort(252_000)).toBe("4m 12s");
    expect(elapsedShort(3_780_000)).toBe("1h 03m");
  });
});

// Gap five + the receipt CHANNEL: raw record in, display filters out.
describe("receipt channel", () => {
  it("a bang command matches its bash-input record — the bang never survives recording", () => {
    expect(receiptFor({ text: "! cd ~/development/trantor && npm publish", at: 1 },
      ["<bash-input> cd ~/development/trantor && npm publish</bash-input>"], 100)).toBe("delivered");
  });

  it("applyRows folds receiptTexts into the ring; applyBackfill's fifth element too", () => {
    const s1 = applyRows({ ...emptyChat, seen: 0 },
      { project: "p", sessionId: "s", after: 0, turns: [], results: [], meta: emptyChat.meta,
        receiptTexts: ["<bash-input> npm publish</bash-input>"] }).state;
    expect(s1.receiptTexts).toEqual(["<bash-input> npm publish</bash-input>"]);
    const s2 = applyBackfill({ ...emptyChat, seen: 0 }, [[], [], 3, emptyChat.meta, ["raw row"]], 0);
    expect(s2.receiptTexts).toEqual(["raw row"]);
  });

  it("the ring caps at 80 — receipts are a window, not an archive", () => {
    const many = Array.from({ length: 100 }, (_, i) => `row ${i}`);
    const s = applyRows({ ...emptyChat, seen: 0 },
      { project: "p", sessionId: "s", after: 0, turns: [], results: [], meta: emptyChat.meta, receiptTexts: many }).state;
    expect(s.receiptTexts.length).toBe(80);
    expect(s.receiptTexts[79]).toBe("row 99");
  });

it("a session change preserves the receipt window so the successor can pull the predecessor's tail", () => {
     const s = applySessionChanged({ ...emptyChat, receiptTexts: ["stale"] });
     expect(s.receiptTexts).toEqual(["stale"]);
   });
});
