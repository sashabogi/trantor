import { describe, expect, it } from "vitest";
import {
  DRILL_STEPS,
  REQUIRED_CARDS,
  disposableProjectName,
  isDisposableProject,
  noteFor,
  statusFor,
  summarize,
} from "./drillSteps";

describe("drillSteps — the catalogue", () => {
  it("covers every visual card the contract names, once each, with an action and an expected result", () => {
    const cards = DRILL_STEPS.map(s => s.card);
    for (const id of REQUIRED_CARDS) expect(cards).toContain(id);
    expect(new Set(cards).size).toBe(cards.length);
    for (const s of DRILL_STEPS) {
      expect(s.title.length).toBeGreaterThan(5);
      expect(s.action.length).toBeGreaterThan(10);
      expect(s.expected.length).toBeGreaterThan(10);
    }
  });

  it("pre-fills only where the app can vouch for itself: chips, overlap, autoscroll arrow, wake header", () => {
    const auto = Object.fromEntries(DRILL_STEPS.map(s => [s.card, s.autoCheck]));
    expect(auto[5993]).toBe("chips-mounted");
    expect(auto[6702]).toBe("chips-lead-in");
    expect(auto[6697]).toBe("jump-arrow-mounted");
    expect(auto[6701]).toBe("composer-no-overlap");
    expect(auto[6201]).toBe("wake-header-pending");
    expect(auto[6483]).toBe("cli-banner-shown");
    // restart, credentials, drag-drop and the wizard need a human; nothing pre-fills them
    for (const id of [6499, 6487, 6392, 6067, 6070]) expect(auto[id]).toBeNull();
  });
});

describe("drillSteps — verdicts and notes", () => {
  it("Pass closes the card and Fail bounces it to doing — no drill-only lane", () => {
    expect(statusFor("pass")).toBe("done");
    expect(statusFor("fail")).toBe("doing");
  });

  it("a Pass note names the drill, the operator, the stage, the screenshot and the auto-check", () => {
    const note = noteFor({
      verdict: "pass", me: "sasha@mac", project: "drill-20260907-2104",
      screenshot: "/Users/s/.agent-bus/drills/1-card-5993.png",
      autoCheck: { ok: true, why: "chip row mounted with 2 chip(s)" }, operatorNote: "",
    });
    expect(note).toBe("drill-mode PASS by sasha@mac on drill-20260907-2104 · screenshot /Users/s/.agent-bus/drills/1-card-5993.png · auto-check ok: chip row mounted with 2 chip(s)");
  });

  it("a Fail note carries the operator's words and says when no auto-check exists", () => {
    const note = noteFor({
      verdict: "fail", me: "sasha@mac", project: "drill-x", screenshot: null, autoCheck: null,
      operatorNote: "  the panel opened on Files again  ",
    });
    expect(note).toBe("drill-mode FAIL by sasha@mac on drill-x · auto-check none (human only) · the panel opened on Files again");
  });

  it("a note never exceeds the hub's 2000-char cap", () => {
    const note = noteFor({ verdict: "fail", me: "m", project: "drill-x", screenshot: null, autoCheck: null, operatorNote: "x".repeat(5000) });
    expect(note.length).toBe(2000);
  });

  it("summarizes passed, failed and skipped against the catalogue size", () => {
    expect(summarize([{ card: 1, verdict: "pass", screenshot: "a" }, { card: 2, verdict: "fail", screenshot: null }], 11))
      .toBe("1 passed · 1 failed · 9 skipped of 11");
  });

  it("the downgraded-CLI step (#6483) sits right before the remove-and-restore step it sets up", () => {
    const cards = DRILL_STEPS.map(s => s.card);
    expect(cards.indexOf(6483)).toBe(cards.indexOf(6487) - 1);
  });
});

describe("drillSteps — the disposable stage", () => {
  it("only a drill-* project is a stage; real projects are refused", () => {
    expect(isDisposableProject("drill-20260907-2104")).toBe(true);
    expect(isDisposableProject("drill-")).toBe(false);
    expect(isDisposableProject("trantor")).toBe(false);
    expect(isDisposableProject("crebral-health")).toBe(false);
  });

  it("names a fresh stage with a sortable stamp that trantor new accepts", () => {
    const name = disposableProjectName(new Date(2026, 8, 7, 21, 4));
    expect(name).toBe("drill-20260907-2104");
    expect(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)).toBe(true);
    expect(isDisposableProject(name)).toBe(true);
  });
});
