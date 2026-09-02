import { describe, expect, it } from "vitest";
import { GENESIS_IDLE, genesisReducer, isExistsNotEmptyError, toastForTransition, type GenesisState } from "./genesisFlow";

describe("genesisFlow", () => {
  it("moves creating -> waking on a successful create — the transition that lets the sheet close", () => {
    const creating = genesisReducer(GENESIS_IDLE, { type: "submit" });
    expect(creating).toEqual({ status: "creating" });
    const waking = genesisReducer(creating, { type: "createOk", project: "pr-os" });
    expect(waking).toEqual({ status: "waking", project: "pr-os" });
    // the toast fired at this transition is the only UI left once the dialog is gone
    expect(toastForTransition(creating, waking)).toEqual({ title: "pr-os created", body: "orchestrator waking" });
  });

  it("offers adopt when the CLI reports a non-empty existing directory", () => {
    const creating = genesisReducer(GENESIS_IDLE, { type: "submit" });
    const message = 'trantor new: "/Users/sasha/development/pr-os" already exists and is not empty — pass --adopt to adopt it';
    expect(isExistsNotEmptyError(message)).toBe(true);
    const exists = genesisReducer(creating, {
      type: "createExists",
      parent: "/Users/sasha/development",
      name: "pr-os",
      message,
    });
    expect(exists).toEqual({ status: "exists", parent: "/Users/sasha/development", name: "pr-os", message });
    // no toast for this one — the sheet itself carries the adopt offer
    expect(toastForTransition(creating, exists)).toBeNull();
  });

  it("does not mistake an unrelated failure for the exists case", () => {
    expect(isExistsNotEmptyError("trantor new failed: git clone failed: repository not found")).toBe(false);
  });

  it("surfaces a wake failure as a toast, since the dialog already closed", () => {
    const waking: GenesisState = { status: "waking", project: "pr-os" };
    const errored = genesisReducer(waking, {
      type: "wakeError",
      message: "pr-os already has a live orchestrator in pane 3",
    });
    expect(errored).toEqual({ status: "error", message: "pr-os already has a live orchestrator in pane 3" });
    expect(toastForTransition(waking, errored)).toEqual({
      title: "Orchestrator wake failed",
      body: "pr-os already has a live orchestrator in pane 3",
    });
  });

  it("produces no toast for a create-time validation error — the sheet's own banner covers it", () => {
    const creating = genesisReducer(GENESIS_IDLE, { type: "submit" });
    const errored = genesisReducer(creating, { type: "createError", message: "Give the project a name." });
    expect(errored).toEqual({ status: "error", message: "Give the project a name." });
    expect(toastForTransition(creating, errored)).toBeNull();
  });

  it("drops a stale event that does not match the current state", () => {
    // a wake result arriving after the state was reset back to idle must not resurrect it
    expect(genesisReducer(GENESIS_IDLE, { type: "wakeOk" })).toEqual(GENESIS_IDLE);
    expect(genesisReducer(GENESIS_IDLE, { type: "wakeError", message: "too late" })).toEqual(GENESIS_IDLE);
  });
});
