// The #5965 fallback selector, pinned: herdr's per-pane agent row is trusted ONLY when it actually
// looked (agent_status present AND screen detection not skipped). A runner-driven seat reports
// screen_detection_skipped, so its herdr row is ignored and the hub status — which the runner now
// writes at every turn boundary — decides. Pure module; no harness needed.
import { describe, expect, it } from "vitest";
import { hubActivity, seatActivity } from "./seatActivity";

describe("hubActivity", () => {
  it("maps the runner's hub status vocabulary", () => {
    expect(hubActivity("working · kickoff")).toBe("working");
    expect(hubActivity("working · direct message")).toBe("working");
    expect(hubActivity("idle")).toBe("idle");
    expect(hubActivity("down: exhausted · 2 fails")).toBe("down");
    expect(hubActivity("errored: auth")).toBe("down");
    expect(hubActivity("")).toBe("idle");
    expect(hubActivity(undefined)).toBe("idle");
  });

  it("older hub rows that say nothing about a turn read idle", () => {
    expect(hubActivity("active in trantor")).toBe("idle");
    expect(hubActivity("crew member booting")).toBe("idle");
  });
});

describe("seatActivity — herdr row trusted only when it observed the pane", () => {
  it("a runner-driven seat (screen_detection_skipped) falls back to the hub status", () => {
    const row = { agent_status: "idle", screen_detection_skipped: true };
    expect(seatActivity(row, "working · direct message")).toBe("working");
    expect(seatActivity(row, "down: exhausted")).toBe("down");
    expect(seatActivity(row, "idle")).toBe("idle");
  });

  it("a herdr row with no agent_status falls back to the hub status", () => {
    expect(seatActivity({ screen_detection_skipped: false }, "working · kickoff")).toBe("working");
    expect(seatActivity({}, "idle")).toBe("idle");
    expect(seatActivity(undefined, "working · pulse")).toBe("working");
  });

  it("a herdr row that DID see the pane is trusted over the hub status", () => {
    const saw = { agent_status: "working", screen_detection_skipped: false };
    expect(seatActivity(saw, "idle")).toBe("working");
    const blocked = { agent_status: "blocked", screen_detection_skipped: false };
    expect(seatActivity(blocked, "idle")).toBe("blocked");
  });

  it("herdr's 'busy' is a working turn too", () => {
    expect(seatActivity({ agent_status: "busy", screen_detection_skipped: false }, "idle")).toBe("working");
  });
});
