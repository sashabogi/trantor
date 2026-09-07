// @vitest-environment happy-dom
//
// #6668 — the built-app drill's pure legs: the banner detector and the verdict. The drill run
// itself needs the built app and a staged bare-shell pane (see handoff_drill.rs); these pin
// what it reads and what it concludes.
import { describe, expect, it } from "vitest";
import { bannerShown, verdict, type HandoffDrillEvidence } from "./handoffDrill";

function evidence(extra: Partial<HandoffDrillEvidence> = {}): HandoffDrillEvidence {
  return {
    probe: { chainStarted: false, withheld: true, refused: true },
    bannerSeen: false,
    rejection: "no live agent in orchestrator pane w9:p1 (herdr reports none) — nothing to hand off",
    ...extra,
  };
}

describe("handoff drill verdict (#6668)", () => {
  it("passes only when nothing fired and the entry guard refused", () => {
    const r = verdict(evidence());
    expect(r.pass).toBe(true);
    expect(r.summary).toContain("entry guard refused");
  });

  it("a chain that started is the failure the drill exists for", () => {
    const r = verdict(evidence({ probe: { chainStarted: true, withheld: true, refused: true } }));
    expect(r.pass).toBe(false);
    expect(r.summary).toContain("a chain started");
  });

  it("a banner on a bare-shell pane fails", () => {
    expect(verdict(evidence({ bannerSeen: true })).pass).toBe(false);
  });

  it("handoff_now resolving, or refusing for another reason, fails", () => {
    expect(verdict(evidence({ rejection: null })).summary).toContain("resolved instead of refusing");
    expect(verdict(evidence({ rejection: "no local checkout for p" })).summary).toContain("another reason");
  });

  it("a missing withheld trace means the staged gauge never crossed the threshold — fail loudly", () => {
    const r = verdict(evidence({ probe: { chainStarted: false, withheld: false, refused: true } }));
    expect(r.pass).toBe(false);
    expect(r.summary).toContain("withheld-gauge");
  });
});

describe("bannerShown", () => {
  it("finds the banner by either of its button labels, and nothing else", () => {
    document.body.innerHTML = '<button>Keep going</button><button>Send</button>';
    expect(bannerShown(document)).toBe(false);
    document.body.innerHTML = '<div><button> Hand off now </button></div>';
    expect(bannerShown(document)).toBe(true);
    document.body.innerHTML = '<button>handing off…</button>';
    expect(bannerShown(document)).toBe(true);
    document.body.innerHTML = "";
  });
});
