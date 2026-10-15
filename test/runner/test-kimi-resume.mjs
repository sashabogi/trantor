import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// kimi-code 0.34 resumes with -S <id> and silently ignores -r, so a -r template made every kimi
// turn a cold new session. Pin the template and the sid capture against kimi's real exit line.
const source = readFileSync(new URL("../../bin/crew-runner.mjs", import.meta.url), "utf8");
const kimi = eval(`(${source.match(/kimi:\s*({ first:[\s\S]*?sid:.*? }),/)[1]})`);
assert.match(kimi.next, /-S \{SID\}/);
assert.doesNotMatch(kimi.next, / -r /);
console.log("ok 1 - the resume template passes the session with -S");
const hint = "To resume this session: kimi -r session_c6791a9b-b075-4971-ac3f-dd323a85704a";
assert.equal(hint.match(kimi.sid)?.[1], "session_c6791a9b-b075-4971-ac3f-dd323a85704a");
assert.equal("To resume this session: kimi -S session_abc".match(kimi.sid)?.[1], "session_abc");
console.log("ok 2 - the sid is captured from kimi's exit hint, -r or -S");

const both = `noise\nTo resume this session:\nkimi -r session_old\nmore\nTo resume this session: kimi -r session_new\n`;
const all = [...both.matchAll(new RegExp(kimi.sid.source, "g"))];
assert.equal(all.at(-1)[1], "session_new");
assert.equal(all[0][1], "session_old");
console.log("ok 3 - a hint split over two lines still matches, and the last one wins");
assert.match(source, /`\$\{r\.stdout \|\| ""\}\\n\$\{ownOut\}`/);
console.log("ok 4 - the sid is read from stdout and stderr, where kimi prints it");
