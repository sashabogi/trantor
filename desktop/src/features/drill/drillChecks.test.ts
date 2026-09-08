// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { WAKE_PENDING_LINE } from "../genesis/wakeRow";
import { rectsOverlap, runAutoCheck } from "./drillChecks";

afterEach(() => { document.body.innerHTML = ""; });

describe("drillChecks — DOM probes pre-fill, never decide", () => {
  it("chips-mounted needs the SuggestionChips row with at least one chip", () => {
    expect(runAutoCheck("chips-mounted", document).ok).toBe(false);
    document.body.innerHTML = '<div data-testid="suggestion-chips"><span data-testid="suggestion-lead-in">suggested</span></div>';
    expect(runAutoCheck("chips-mounted", document)).toEqual({ ok: false, why: "chip row mounted but holds no chips" });
    document.body.innerHTML = '<div data-testid="suggestion-chips"><span data-testid="suggestion-lead-in">suggested</span><button class="tr-chip">yes</button><button class="tr-chip">no</button></div>';
    expect(runAutoCheck("chips-mounted", document)).toEqual({ ok: true, why: "chip row mounted with 2 chip(s)" });
  });

  it("chips-lead-in passes only when the row leads with the question, not 'suggested'", () => {
    document.body.innerHTML = '<div data-testid="suggestion-chips"><span data-testid="suggestion-lead-in">suggested</span></div>';
    expect(runAutoCheck("chips-lead-in", document).ok).toBe(false);
    document.body.innerHTML = '<div data-testid="suggestion-chips"><span data-testid="suggestion-lead-in">Merge to main?</span></div>';
    expect(runAutoCheck("chips-lead-in", document)).toEqual({ ok: true, why: "lead-in reads 'Merge to main?'" });
  });

  it("jump-arrow-mounted reads Chat's jump-to-latest button and its unseen dot", () => {
    expect(runAutoCheck("jump-arrow-mounted", document).ok).toBe(false);
    document.body.innerHTML = '<button aria-label="Jump to latest"></button>';
    expect(runAutoCheck("jump-arrow-mounted", document)).toEqual({ ok: true, why: "jump arrow mounted" });
    document.body.innerHTML = '<button aria-label="Jump to latest — new messages below"><span data-testid="chat-unseen"></span></button>';
    expect(runAutoCheck("jump-arrow-mounted", document)).toEqual({ ok: true, why: "jump arrow mounted with the unseen dot" });
  });

  it("composer-no-overlap compares the gauge and the Aa control's rects", () => {
    expect(runAutoCheck("composer-no-overlap", document).ok).toBe(false);
    document.body.innerHTML =
      '<div id="gauge" title="12% of 200k"><span>context</span><div></div></div><button title="Chat text size">Aa</button>';
    const gauge = document.getElementById("gauge")!;
    const aa = document.querySelector<HTMLElement>('button[title="Chat text size"]')!;
    const rect = (left: number, right: number) => () => ({ left, right, top: 0, bottom: 10, width: right - left, height: 10, x: left, y: 0, toJSON: () => ({}) });
    gauge.getBoundingClientRect = rect(0, 100);
    aa.getBoundingClientRect = rect(120, 140);
    expect(runAutoCheck("composer-no-overlap", document)).toEqual({ ok: true, why: "gauge and Aa rects are disjoint" });
    aa.getBoundingClientRect = rect(90, 110);
    expect(runAutoCheck("composer-no-overlap", document)).toEqual({ ok: false, why: "the context gauge and the Aa control overlap" });
  });

  it("wake-header-pending looks for wakeRow's exact pending line on screen", () => {
    expect(runAutoCheck("wake-header-pending", document).ok).toBe(false);
    document.body.innerHTML = `<span>${WAKE_PENDING_LINE}</span>`;
    expect(runAutoCheck("wake-header-pending", document).ok).toBe(true);
  });

  it("cli-banner-shown looks for AccountsPane's minimum-version banner text", () => {
    expect(runAutoCheck("cli-banner-shown", document).ok).toBe(false);
    document.body.innerHTML = '<div role="alert">trantor CLI 0.18.46 is older than this app needs (0.18.47) — npm i -g trantor@0.18.47</div>';
    expect(runAutoCheck("cli-banner-shown", document)).toEqual({ ok: true, why: "the CLI minimum-version banner is on screen" });
  });

  it("rectsOverlap treats touching edges and empty rects as not overlapping", () => {
    expect(rectsOverlap({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 10, right: 20, top: 0, bottom: 10 })).toBe(false);
    expect(rectsOverlap({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 5, right: 20, top: 5, bottom: 20 })).toBe(true);
    expect(rectsOverlap({ left: 0, right: 0, top: 0, bottom: 0 }, { left: 0, right: 20, top: 0, bottom: 20 })).toBe(false);
  });
});
