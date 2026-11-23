// #13961 follow-up: the seat rules once told agents to `git reset --hard <base>` themselves. That
// hand reset skipped the runner's harvest/ save, and glm-5's finished #13964 commit was orphaned.
// The runner aligns every contract turn; the rules must never tell an agent to reset.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../../bin/crew-runner.mjs", import.meta.url)), "utf8");
const rules = src.match(/const RULES = process\.env\.RUNNER_RULES \|\| `([\s\S]*?)`;\n/)?.[1] || "";
let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) failed++; };

ok("the seat rules are found in bin/crew-runner.mjs", rules.length > 1000);
ok("no rule tells a seat to hard-reset its branch", !/git reset --hard <sha>/.test(rules) && !/start your seat branch at that sha/.test(rules));
ok("the rules forbid resetting, rebasing or checking out the seat branch by hand", /Never \\`git reset\\`, \\`rebase\\` or \\`checkout\\` your seat branch yourself/.test(rules));
ok("the rules say the runner already aligned the branch and saved unharvested work", /runner has already aligned your seat branch/.test(rules) && /harvest\/<card>/.test(rules));

console.log(failed ? `\n${failed} rules check(s) failed` : "\nseat rules: no hand reset");
process.exit(failed ? 1 : 0);
