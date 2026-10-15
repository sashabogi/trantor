import assert from "node:assert/strict";
import { runnerCommand, RUNNER_LIMIT_FLAGS } from "../../bin/crew/core.mjs";

// The card limits are read by the runner process, so `trantor up` has to carry them into the pane
// command; a limit set where the seat was started never reached it before.
const ctx = { dir: "/tmp/proj", project: "proj", hub: "http://hub" };
const saved = Object.fromEntries(RUNNER_LIMIT_FLAGS.map(name => [name, process.env[name]]));
try {
  for (const name of RUNNER_LIMIT_FLAGS) delete process.env[name];
  const bare = runnerCommand(ctx, "kimi");
  for (const name of RUNNER_LIMIT_FLAGS) assert.ok(!bare.includes(`${name}=`), name);
  console.log("ok 1 - unset limits are not forwarded");

  process.env.TRANTOR_CARD_CONTEXT_CAP = "40000";
  process.env.TRANTOR_CARD_CAP_MIN_STEPS = "1";
  process.env.TRANTOR_CARD_TOKEN_BUDGET = "500000";
  const cmd = runnerCommand(ctx, "kimi");
  assert.ok(cmd.includes("TRANTOR_CARD_CONTEXT_CAP=40000"), cmd);
  assert.ok(cmd.includes("TRANTOR_CARD_CAP_MIN_STEPS=1"), cmd);
  assert.ok(cmd.includes("TRANTOR_CARD_TOKEN_BUDGET=500000"), cmd);
  assert.ok(cmd.indexOf("TRANTOR_CARD_CONTEXT_CAP") < cmd.indexOf("crew-runner.mjs"), cmd);
  console.log("ok 2 - set limits ride the runner command");
} finally {
  for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
}
