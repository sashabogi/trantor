// #6201 — the wake chain's frontend contract: the row-state mapping, the header text, and the
// event guard, all pure so a mid-chain window drills without Rust or a herdr socket. The phase
// NAMES come from genesis.rs (kickoff_phase_names_are_the_frontend_contract); a rename there
// breaks this file first.
import { describe, expect, it } from "vitest";
import { applyWakeProgress, wakeProgressRowState, wakeProgressText, type WakeProgress } from "./wakeProgress";
import { WAKE_PENDING_LINE, WAKE_SENT_LINE, type WakeRowState } from "./wakeRow";

const ev = (phase: WakeProgress["phase"], detail: string | null = null, project = "pr-os"): WakeProgress =>
  ({ project, phase, detail });

describe("wakeProgress phase mapping (#6201)", () => {
  it("reads the gate and the send as kickoff pending/sent on the row", () => {
    expect(wakeProgressRowState("opened", null)).toEqual({ phase: "kickoff", step: "pending" });
    expect(wakeProgressRowState("waiting_idle", null)).toEqual({ phase: "kickoff", step: "pending" });
    expect(wakeProgressRowState("kickoff_sent", null)).toEqual({ phase: "kickoff", step: "sent" });
  });

  it("reads landed as the outcome: delivered is the good ending, anything else stays to be read", () => {
    const good = wakeProgressRowState("kickoff_landed", "prompt delivered — successor is recapping");
    expect(good).toEqual({ phase: "outcome", kind: "sent", text: "prompt delivered — successor is recapping" });
    const bad = wakeProgressRowState("kickoff_landed", "no lifecycle change observed — recap may not land");
    expect(bad).toEqual({ phase: "outcome", kind: "error", text: "no lifecycle change observed — recap may not land" });
    const bare = wakeProgressRowState("kickoff_landed", null);
    expect(bare).toEqual({ phase: "outcome", kind: "error", text: "kickoff ended" });
  });

  it("ended maps to null — the caller clears the row", () => {
    expect(wakeProgressRowState("ended", null)).toBeNull();
  });

  it("the header says kickoff pending during the gate and the outcome after", () => {
    expect(wakeProgressText("waiting_idle", null)).toEqual({ kind: "pending", text: WAKE_PENDING_LINE });
    expect(wakeProgressText("opened", null)).toEqual({ kind: "pending", text: WAKE_PENDING_LINE });
    expect(wakeProgressText("kickoff_sent", null)).toEqual({ kind: "pending", text: WAKE_SENT_LINE });
    expect(wakeProgressText("kickoff_landed", "prompt delivered — successor is recapping"))
      .toEqual({ kind: "outcome", text: "prompt delivered — successor is recapping" });
    expect(wakeProgressText("ended", null)).toBeNull();
  });
});

describe("applyWakeProgress — the event guard (#6201)", () => {
  it("chains a row through pending → sent → outcome as the events arrive", () => {
    let m = new Map<string, WakeRowState>();
    m = applyWakeProgress(m, ev("opened"));
    expect(m.get("pr-os")).toEqual({ phase: "kickoff", step: "pending" });
    m = applyWakeProgress(m, ev("waiting_idle"));
    expect(m.get("pr-os")).toEqual({ phase: "kickoff", step: "pending" });
    m = applyWakeProgress(m, ev("kickoff_sent"));
    expect(m.get("pr-os")).toEqual({ phase: "kickoff", step: "sent" });
    m = applyWakeProgress(m, ev("kickoff_landed", "prompt delivered — successor is recapping"));
    expect(m.get("pr-os")?.phase).toBe("outcome");
  });

  it("ended clears an in-flight row but never cuts a showing outcome short", () => {
    // A refused wake (busy pane, no checkout) emits ONLY ended — the row clears.
    let m = applyWakeProgress(new Map(), ev("waiting_idle"));
    m = applyWakeProgress(m, ev("ended"));
    expect(m.has("pr-os")).toBe(false);
    // The landed outcome re-set by the command's own answer (with its fade timer) survives an
    // ended that overtakes it — the "few seconds" belong to the operator, not the event order.
    const outcome = new Map<string, WakeRowState>([
      ["pr-os", { phase: "outcome", kind: "sent", text: "prompt delivered" }],
    ]);
    expect(applyWakeProgress(outcome, ev("ended"))).toBe(outcome);
  });

  it("only touches the event's own project and ignores a repeated step", () => {
    const m = new Map<string, WakeRowState>([["other", { phase: "outcome", kind: "busy", text: "busy" }]]);
    const next = applyWakeProgress(m, ev("waiting_idle", null, "other"));
    expect(next.get("other")).toEqual({ phase: "kickoff", step: "pending" });
    const again = applyWakeProgress(next, ev("waiting_idle", null, "other"));
    expect(again).toBe(next); // same pending step twice: same map back, no rerender
  });
});
