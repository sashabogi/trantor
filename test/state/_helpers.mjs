// Shared fixtures for the Phase-0 suites. Not a suite itself (the runner discovers test-*.mjs).
import { emptyState } from "../../lib/state/schema.mjs";

export function harness() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
  };
  const done = () => {
    console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\nALL PASS (${pass})`);
    process.exit(fail ? 1 : 0);
  };
  return { ok, done, counts: () => ({ pass, fail }) };
}

/** A state with one in-flight item, ready to be moved to done. */
export function stateWithItem(overrides = {}) {
  const s = emptyState(6895, "claude:trantor");
  s.task = "build the pure core";
  s.in_flight = [{ id: "x1", text: "wire the validator", paths: ["lib/state/validate.mjs"] }];
  return { ...s, ...overrides };
}

export const ACT = { continue: true };
export const turn = (patch, action = ACT) => ({ patch, action });
