#!/usr/bin/env node
// Which provider key does a crew seat actually spend on?
//
// bin/crew-runner.mjs wraps every turn in `source <file>` lines so the seat's CLI finds its API
// keys. The ORDER decides which key wins, and it has been wrong twice. On 2026-08-25 the crew layer
// (~/.agent-bus/.env) was being sourced FIRST, so ~/.token-scrooge/.env overrode it and every seat
// authenticated with Scrooge's key — one key paying for two very different workloads, and a $14
// DeepSeek day that no bill could attribute (Scrooge was 0.15% of the tokens on that key).
//
// The comment above the code claimed the opposite of what the code did, so this drill runs a REAL
// bash and reads the value that actually survives. A comment is not evidence.
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnvFiles } from "./lib/project.mjs";
import { drillEnv } from "./drill-env.mjs";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const dir = mkdtempSync(join(tmpdir(), "trantor-crewenv-"));
const crew = join(dir, "crew.env"), scrooge = join(dir, "scrooge.env");
writeFileSync(crew, "DEEPSEEK_API_KEY=CREW_KEY\nCREW_ONLY=yes\n");
writeFileSync(scrooge, "DEEPSEEK_API_KEY=SCROOGE_KEY\nSCROOGE_ONLY=yes\n");
// The child env is pinned (#6108): a seat shell (and the runner itself) exports DEEPSEEK_API_KEY,
// and the "no files" case asserts the variable is UNSET — inheriting the host's key made the
// assertion test the runner instead of the sourcing order. The drill varies these names itself.
const childEnv = drillEnv();
for (const k of ["DEEPSEEK_API_KEY", "CREW_ONLY", "SCROOGE_ONLY"]) delete childEnv[k];
const runFor = (v, files) => execSync(withEnvFiles(`printf '%s' "$${v}"`, files), { shell: "/bin/bash", encoding: "utf8", env: childEnv }).trim();

console.log("# crew seat env precedence");

// Files are passed in PRIORITY order: crew layer first.
const both = [crew, scrooge];
ok("the CREW layer wins over Scrooge's for a shared key name",
  runFor("DEEPSEEK_API_KEY", both) === "CREW_KEY", runFor("DEEPSEEK_API_KEY", both));
ok("…and a key only Scrooge has still comes through (fallback, not replacement)",
  runFor("SCROOGE_ONLY", both) === "yes");
ok("…and a key only the crew has comes through too",
  runFor("CREW_ONLY", both) === "yes");

// The single-file cases must not depend on ordering at all.
ok("with only the crew layer, the crew key is used", runFor("DEEPSEEK_API_KEY", [crew]) === "CREW_KEY");
ok("with only Scrooge's file, its key is used (the documented fallback)",
  runFor("DEEPSEEK_API_KEY", [scrooge]) === "SCROOGE_KEY");
ok("no files at all leaves the variable unset rather than erroring",
  runFor("DEEPSEEK_API_KEY", []) === "");

// The mechanism itself: highest priority is prepended FIRST so it EXECUTES LAST.
const built = withEnvFiles("CMD", both);
ok("the highest-priority file is sourced LAST in the built command",
  built.indexOf(scrooge) < built.indexOf(crew), built);
ok("the command itself stays at the end", built.trim().endsWith("CMD"));
ok("withEnvFiles does not mutate the caller's array", both[0] === crew && both[1] === scrooge);

console.log(`\n${fail === 0 ? "✅" : "❌"} crew env: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
