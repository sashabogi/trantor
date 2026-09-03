#!/usr/bin/env node
// Genesis PRD-review path drill (#6112). Three layers: (1) the pure kickoff decision — blank vs
// brief vs adopted-with-PRD vs a board that already carries build work; (2) the REAL path of the
// CLI selector as a child process against a throwaway hub, the way the app runs it: `trantor new`
// stands the projects up, then `genesis-kickoff` reads the checkout + the signed board and prints
// the one line the app relays; (3) the skill text checked against the operator's 23:20 ruling
// word by word — reviewers, rubric, consensus, gates — because the skill IS the flow the
// orchestrator runs, and a drift there is a drift in the product. Every spawn pins its env with
// drillEnv() (#6108) so the drill passes from inside a herdr pane as well as from a shell.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv, scrubIdentityEnv } from "./drill-env.mjs";
import {
  PLAIN_WAKE_KICKOFF,
  PRD_REVIEW_KICKOFF,
  isBuildCard,
  selectGenesisKickoff,
} from "./bin/genesis-kickoff.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
scrubIdentityEnv();

console.log("# genesis PRD-review path");

// ── 1. the decision, without a hub ──────────────────────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), "trantor-prd-review-"));
  const blank = join(root, "blank");
  const fromBrief = join(root, "from-brief");
  const adopted = join(root, "adopted");
  mkdirSync(blank, { recursive: true });
  mkdirSync(join(fromBrief, "docs"), { recursive: true });
  mkdirSync(join(adopted, "docs"), { recursive: true });
  writeFileSync(join(fromBrief, "docs", "PRD.md"), "# New brief\n");
  writeFileSync(join(adopted, "docs", "PRD.md"), "# Existing brief\n");

  ok("blank project receives the plain wake", selectGenesisKickoff({ dir: blank, tasks: [] }) === PLAIN_WAKE_KICKOFF);
  ok("a brief with only its genesis card enters PRD review", selectGenesisKickoff({
    dir: fromBrief, tasks: [{ title: "genesis: from-brief" }],
  }) === PRD_REVIEW_KICKOFF);
  ok("adopted project with a PRD and an empty board enters PRD review", selectGenesisKickoff({ dir: adopted, tasks: [] }) === PRD_REVIEW_KICKOFF);
  ok("a PRD whose board already carries build work wakes plainly", selectGenesisKickoff({
    dir: adopted, tasks: [{ title: "Implement authentication", phase: "build" }],
  }) === PLAIN_WAKE_KICKOFF);
  ok("a board that could not be read fails closed to the plain wake", selectGenesisKickoff({ dir: adopted, tasks: null }) === PLAIN_WAKE_KICKOFF);
  ok("the review cards this flow opens are not build work",
    !isBuildCard({ title: "PRD review: adopted", phase: "PRD" }) && !isBuildCard({ title: "TDD review: adopted", phase: "TDD" }));
  ok("a session's own auto-cards (prompts, sub-agents) are conversation, not build work",
    !isBuildCard({ title: "So what do I do with the PRD", source: "session" })
    && !isBuildCard({ title: "Explore: map the repo", source: "cc-subagent" })
    && !isBuildCard({ title: "Research task", source: "cc-bg-agent" }));
  ok("a commit auto-card is build work", isBuildCard({ title: "feat: add login", source: "git" }));
  ok("ordinary unphased work is conservatively a build card", isBuildCard({ title: "Implement the accepted work breakdown" }));
  ok("the plain wake is the app's own wake prompt, word for word",
    PLAIN_WAKE_KICKOFF.startsWith("You were just woken via Trantor.") && PLAIN_WAKE_KICKOFF.endsWith("and wait."));
  rmSync(root, { recursive: true, force: true });
}

// ── 2. the real path: trantor new, then the selector as the app runs it ─────────────────────────
{
  const W = mkdtempSync(join(tmpdir(), "trantor-prd-review-hub-"));
  const DEV = join(W, "dev");
  mkdirSync(DEV, { recursive: true });
  mkdirSync(join(W, ".agent-bus"), { recursive: true });
  writeFileSync(join(W, ".agent-bus", "autonomy.json"), JSON.stringify({ version: 1, defaults: { harness: "bypass" }, projects: {} }));
  const PORT = 47881, HUB = `http://127.0.0.1:${PORT}`;
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: W, HOME: W, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let hubErr = "";
  hub.stderr.on("data", d => { hubErr += String(d); });
  let hubUp = false;
  for (let i = 0; i < 50; i++) {
    if (hub.exitCode !== null) { console.error("hub exited early:", hubErr); process.exit(1); }
    try { const r = await fetch(`${HUB}/health`); if (r.ok) { hubUp = true; break; } } catch {}
    await sleep(100);
  }
  ok("throwaway hub is up", hubUp);

  const env = (extra = {}) => ({
    ...drillEnv(), HOME: W, AGENT_BUS_DIR: join(W, ".agent-bus"), RELAY_URL: HUB,
    TRANTOR_DEV_ROOT: DEV, TRANTOR_NO_UPDATE_CHECK: "1", ...extra,
  });
  const runNew = (args) => spawnSync("node", [join(ROOT, "bin", "new.mjs"), ...args, "--json"], { encoding: "utf8", cwd: W, env: env({ RELAY_SESSION: "genesis-test" }) });
  // The app runs `trantor genesis-kickoff <project>` IN the checkout, with no runner identity.
  const kickoff = (project, dir, extra = {}) => spawnSync("node", [join(ROOT, "bin", "genesis-kickoff.mjs"), project], { encoding: "utf8", cwd: dir, env: env(extra) });

  const briefFile = join(W, "portal-prd.md");
  writeFileSync(briefFile, "# Client portal\n\nA portal for clients.\n");
  const a = runNew(["kick-blank"]);
  const b = runNew(["kick-brief", "--brief", briefFile]);
  let aJson = null, bJson = null;
  try { aJson = JSON.parse(a.stdout); bJson = JSON.parse(b.stdout); } catch {}
  ok("trantor new stood both projects up", a.status === 0 && b.status === 0 && !!aJson?.dir && !!bJson?.dir, `${a.status}/${b.status} ${(a.stderr + b.stderr).slice(-300)}`);
  ok("blank genesis writes NO docs/PRD.md (a placeholder would wake into a review of nothing)",
    !!aJson && !readFileSafe(join(aJson.dir, "docs", "PRD.md")));
  ok("blank genesis: CLAUDE.md says there is no brief", !!aJson && (readFileSafe(join(aJson.dir, "CLAUDE.md")) || "").includes("No project brief was supplied"));
  ok("brief genesis: the brief is complete in docs/PRD.md and CLAUDE.md points at it",
    !!bJson && readFileSafe(join(bJson.dir, "docs", "PRD.md")) === "# Client portal\n\nA portal for clients.\n"
    && (readFileSafe(join(bJson.dir, "CLAUDE.md")) || "").includes("docs/PRD.md"));

  const ka = aJson ? kickoff("kick-blank", aJson.dir) : null;
  ok("selector: blank project → plain wake, exit 0", !!ka && ka.status === 0 && ka.stdout.trim() === PLAIN_WAKE_KICKOFF, ka ? `${ka.status} ${ka.stdout}${ka.stderr}` : "no project");
  const kb = bJson ? kickoff("kick-brief", bJson.dir) : null;
  ok("selector: brief project with only its genesis card → PRD review, exit 0", !!kb && kb.status === 0 && kb.stdout.trim() === PRD_REVIEW_KICKOFF, kb ? `${kb.status} ${kb.stdout}${kb.stderr}` : "no project");
  ok("selector prints exactly one line (the app relays stdout verbatim)", !!kb && kb.stdout.trim().split("\n").length === 1);

  // The board grows a build card: the same wake is now a plain one — a review is not re-convened
  // over a project that is already being built.
  if (bJson) {
    const r = await fetch(`${HUB}/task`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "kick-brief", title: "Implement the client login", status: "todo", phase: "build", by: "drill" }) });
    ok("a build card lands on the brief project's board", r.ok);
    const kc = kickoff("kick-brief", bJson.dir);
    ok("selector: brief project WITH build work → plain wake", kc.status === 0 && kc.stdout.trim() === PLAIN_WAKE_KICKOFF, `${kc.status} ${kc.stdout}${kc.stderr}`);
  }

  // Adopted: a checkout with docs/PRD.md that genesis never touched and a board with no cards —
  // pr-os's shape. The next Wake convenes its review; no re-genesis needed.
  const adopted = join(DEV, "kick-adopted");
  mkdirSync(join(adopted, "docs"), { recursive: true });
  writeFileSync(join(adopted, "docs", "PRD.md"), "# Parked PRD\n");
  const kd = kickoff("kick-adopted", adopted);
  ok("selector: adopted checkout with a PRD and no cards → PRD review", kd.status === 0 && kd.stdout.trim() === PRD_REVIEW_KICKOFF, `${kd.status} ${kd.stdout}${kd.stderr}`);

  // A hub that is down: exit 1 with the reason, and NOTHING on stdout — the app must fall back to
  // its own plain wake rather than relay an empty or partial line.
  const ke = kickoff("kick-adopted", adopted, { RELAY_URL: "http://127.0.0.1:1" });
  ok("selector: PRD present but board unreachable → exit 1, empty stdout, reason on stderr",
    ke.status === 1 && ke.stdout.trim() === "" && /could not be read/.test(ke.stderr) && /unreachable/.test(ke.stderr), `${ke.status} ${ke.stdout}${ke.stderr}`);

  hub.kill();
  try { rmSync(W, { recursive: true, force: true }); } catch {}
}

function readFileSafe(p) { try { return readFileSync(p, "utf8"); } catch { return null; } }

// ── 3. the skill against the ruling ─────────────────────────────────────────────────────────────
{
  const skill = readFileSync(join(ROOT, "skills", "prd-review", "SKILL.md"), "utf8");
  const has = (...parts) => parts.every(part => skill.includes(part));
  ok("frontmatter: name, user-invocable, and the trigger", has("name: prd-review", "user-invocable: true", "Trigger: /trantor:prd-review"));
  ok("the orchestrator convenes and synthesizes and never votes", has("You convene", "you synthesize", "never vote", "do\nnot review the document yourself"));
  ok("reviewers: every live crew seat plus two Scrooge readers on different models",
    has("every live seat of the project's crew plus two Scrooge readers\non two different models", "`relay_scrooge` twice with the identical rubric", "the two must differ"));
  ok("no crew: bring one up first, subscription seats per the profile, no second ask",
    has("Bring one up FIRST through `/trantor:crew`", "SUBSCRIPTION seats the operator's profile declares", "do not ask again"));
  ok("the rubric in the ruling's words and order",
    has("1. **completeness**", "2. **ambiguity**", "3. **feasibility and risk**", "4. **missing requirements**", "5. **a proposed scope cut**", "**VERDICT: READY** or **VERDICT: REVISE**, with the gaps listed"));
  ok("one card, one checklist item per reviewer, the rubric dispatched over the bus",
    has("title `PRD review: <project>`", "exactly ONE item per reviewer", "`relay_send` every crew seat the same contract"));
  ok("each reviewer answers as a card note in the rubric's shape and ticks only its item",
    has("A seat records its review with `relay_task_move`", "ticks only its own checklist item"));
  ok("consensus: all READY = pass; any REVISE = ONE merged revision request",
    has("**All READY** = the crew's pass", "**Any REVISE** = you merge every gap from every reviewer", "ONE\n  revision request"));
  ok("the operator gate is ask mode and the operator may override either way",
    has("goes to the OPERATOR in ask mode", "override a REVISE into a pass", "send a\nunanimous READY back for revision"));
  ok("the outcome lands on the card and the card closes on pass",
    has("Record the decision and its reason as a card note", "move the card to `testing` with the tally", "to `done`"));
  ok("TDD phase: one author, docs/TDD.md, the same frozen reviewers, the same gate",
    has("Pick ONE live crew seat as the author", "write `docs/TDD.md`", "the same seats and the same two models", "**Same consensus, same operator gate**"));
  ok("build cards open on a TDD pass per the autonomy dial with no extra ask",
    has("Do not ask the operator again merely to open its build cards", "phase `build`", "autonomy dial (`trantor autonomy`)"));
  ok("the skill names the resume entry point", has("`/trantor:prd-review tdd` resumes here"));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} prd-review: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
