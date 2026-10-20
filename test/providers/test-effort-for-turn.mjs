#!/usr/bin/env node
// Card #12072: reasoning effort follows the bound card's difficulty each turn.
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { effortForTurn, resolveEffort, cliEffortFlag } = await import(pathToFileURL(join(root, "lib/model-catalog.mjs")).href);

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name} ${detail}`); }
};

const seats = [["codex", ""], ["claude", ""], ["opencode", "zai-coding-plan/glm-5.3-flash"]];
for (const [agent, model] of seats) {
  const launch = resolveEffort(agent, model, "medium");
  for (const d of ["easy", "medium", "hard"]) {
    const got = effortForTurn({ agent, model, launchEffort: launch, cardDifficulty: d });
    const want = cliEffortFlag(agent, resolveEffort(agent, model, d));
    check(`${agent} ${d}: flag matches the catalog`, got.flag === want.flag, `${got.flag} vs ${want.flag}`);
  }
  const same = effortForTurn({ agent, model, launchEffort: launch, cardDifficulty: "medium" });
  check(`${agent}: a card at the launch difficulty is not a change`, !same.changed);
}

const codexLaunch = resolveEffort("codex", "", "medium");
const hard = effortForTurn({ agent: "codex", model: "", launchEffort: codexLaunch, cardDifficulty: "hard" });
check("codex hard sets model_reasoning_effort", /model_reasoning_effort="\w+"/.test(hard.flag), hard.flag);
check("codex hard reports the hard effort record and a change", hard.effort.difficulty === "hard" && hard.changed);

const launchFlag = cliEffortFlag("codex", codexLaunch).flag;
for (const bad of ["", null, undefined, "extreme", "7"]) {
  const got = effortForTurn({ agent: "codex", model: "", launchEffort: codexLaunch, cardDifficulty: bad });
  check(`codex difficulty ${JSON.stringify(bad)} keeps launch`, got.flag === launchFlag && !got.changed && got.effort === codexLaunch);
}
check("difficulty is case-insensitive", effortForTurn({ agent: "codex", model: "", launchEffort: codexLaunch, cardDifficulty: "HARD" }).flag === hard.flag);

for (const agent of ["kimi", "dsh"]) {
  const launch = resolveEffort(agent, "", "medium");
  const got = effortForTurn({ agent, model: "", launchEffort: launch, cardDifficulty: "hard" });
  check(`${agent} takes no flag`, got.flag === "" && !got.changed);
}

const none = effortForTurn({ agent: "codex", model: "", launchEffort: null, cardDifficulty: "hard" });
check("no launch effort still resolves from the card", /model_reasoning_effort/.test(none.flag) && none.changed);
const nothing = effortForTurn({ agent: "codex", model: "", launchEffort: null, cardDifficulty: null });
check("no launch effort and no difficulty gives no flag", nothing.flag === "" && !nothing.changed && nothing.effort === null);
check("garbage input does not throw", effortForTurn({}).flag === "");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
