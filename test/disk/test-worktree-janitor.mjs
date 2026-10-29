#!/usr/bin/env node
// #12269 janitor tests — temp HOME, injected exec/remove/log, fixed clock: no real
// simctl, opencode, docker, git deletion, and nothing outside the temp dir is touched.
import * as nodeFs from "node:fs";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDiskReport, runClean, runDisk, formatHuman, launchdPlist, freedOnDiskBytes,
  scanStaleWorktrees, scanNestedBuildOutput, DAY, WORKTREE_IDLE_MAX, BUILD_OUTPUT_IDLE_MAX,
} from "../../lib/disk.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

console.log("# trantor worktree janitor tests");

// realpath first: macOS tmpdir() hands out /var/... which resolves to /private/var/...,
// and assertUnderHome's resolve() would otherwise fail the startsWith(HOME) check.
const HOME = mkdtempSync(join(tmpdir(), "trantor-janitor-home-"));
const NOW = 1_800_000_000_000;
const OLD7 = NOW - 8 * DAY;   // beyond the 7-day worktree window

const ROOT = join(HOME, ".agent-bus", "worktrees");
const wt = (proj, seat) => join(ROOT, proj, seat);

// Backdate a whole tree to `t` — the age rules read max mtime over files AND dirs.
function ageTree(root, t) {
  utimesSync(root, new Date(t), new Date(t));
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) ageTree(p, t);
    else { try { utimesSync(p, new Date(t), new Date(t)); } catch {} }
  }
}

// Canned exec: answers by command shape. `dirty` maps worktree path -> porcelain output;
// `tracked` maps rel path -> ls-files output; `psLines` is the ps snapshot.
function makeExec({ dirty = {}, tracked = {}, psLines = [] } = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, args]);
    const a = args.join(" ");
    if (file === "ps") return { stdout: psLines.join("\n"), status: 0 };
    if (file === "git" && a.includes("status --porcelain")) {
      const cwd = args[args.indexOf("-C") + 1];
      return { stdout: dirty[cwd] || "", status: 0 };
    }
    if (file === "git" && a.includes("ls-files")) {
      const rel = args[args.indexOf("--") + 1] || "";
      return { stdout: tracked[rel] || "", status: 0 };
    }
    if (file === "git" && a.includes("worktree remove")) return { stdout: "", stderr: "", status: 0 };
    if (file === "xcrun") return { stdout: "", status: 1 };
    if (file === "opencode") return { stdout: "", status: 1 };
    return { stdout: "", status: 1 };
  };
  return { exec, calls };
}

try {
  // ---- fixtures ----
  // "fresh" means NOW on the FIXED clock: real creation time drifts stale against it, so
  // every must-stay-fresh tree is explicitly stamped with NOW (as test-disk.mjs does).
  const idle = wt("proj", "idle-clean");       // 8d old, clean, dead → PRUNE
  const dirty = wt("proj", "dirty");           // 8d old, uncommitted changes → KEPT, NAMED
  const fresh = wt("proj", "fresh");           // touched now → KEPT
  const live = wt("proj", "live");             // a live process names its path → KEPT
  const stamped = wt("proj", "stamped");       // crew row alone → KEPT
  for (const w of [idle, dirty, fresh, live, stamped]) {
    mkdirSync(join(w, "src"), { recursive: true });
    writeFileSync(join(w, "src", "a.js"), "x".repeat(2048));
  }
  // the FRESH nested fixture lives in the `fresh` worktree — inside `idle` its NOW mtime
  // would (correctly) mark the whole tree touched and keep it out of the prune plan
  const ddFresh = join(fresh, ".agent-bus-out", "build2", "DerivedData");

  // nested build output inside the dead seat's scratch — created BEFORE the whole tree
  // is aged, so every nested path carries the old stamp
  const dd = join(idle, ".agent-bus-out", "build", "DerivedData");
  const xcr = join(idle, ".agent-bus-out", "shots", "run.xcresult");
  const ddTop = join(idle, ".agent-bus-out", "DerivedData"); // top-level: scratch rule owns it
  const ddTracked = join(idle, ".agent-bus-out", "vendored", "target");
  for (const p of [dd, xcr, ddFresh, ddTop, ddTracked]) {
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "blob.bin"), "b".repeat(4096));
  }
  ageTree(idle, OLD7);
  ageTree(fresh, NOW);
  ageTree(stamped, NOW);

  const { exec } = makeExec({
    psLines: [`100 1 node /fixture/crew-runner.mjs live ${live}`, "101 100 worker"],
    dirty: { [dirty]: " M src/a.js" },
    tracked: { [join(".agent-bus-out", "vendored", "target")]: "some/file" },
  });

  // ---- scanStaleWorktrees ----
  console.log("\nscanStaleWorktrees plans idle clean dead worktrees and keeps the rest:");
  const stale = scanStaleWorktrees({ fs: nodeFs, exec, home: HOME, now: NOW, worktreesRoot: ROOT, entryBudget: 50_000 });
  const planned = stale.plan.map((p) => p.path);
  ok("idle 8d clean dead worktree is planned for pruning", planned.includes(idle), JSON.stringify(planned));
  ok("the planned item carries its size (src file + 4 nested blobs)",
    stale.plan.find((p) => p.path === idle)?.bytes === 2048 + 4 * 4096,
    String(stale.plan.find((p) => p.path === idle)?.bytes));
  const keptReasons = Object.fromEntries(stale.kept.map((k) => [k.path, k.reason]));
  ok("a worktree with uncommitted changes is kept", !!keptReasons[dirty]);
  ok("the kept dirty worktree is NAMED with its reason", (keptReasons[dirty] || "").includes("uncommitted changes"), keptReasons[dirty]);
  ok("a freshly touched worktree is kept", !!keptReasons[fresh], JSON.stringify(Object.keys(keptReasons)));
  ok("a worktree a live process uses is kept", !!keptReasons[live]);
  ok("a freshly touched worktree is kept by the age rule", (keptReasons[stamped] || "").includes("touched within 7 days"), keptReasons[stamped]);
  ageTree(stamped, OLD7);
  const statePath = join(HOME, ".agent-bus", "crew-windows.txt");
  const scan = (run = exec) => scanStaleWorktrees({ fs: nodeFs, exec: run, home: HOME, now: NOW, worktreesRoot: ROOT, entryBudget: 50_000 });
  const stale2 = scan();
  ok("an old clean seat without a crew row or process is planned", stale2.plan.some(p => p.path === stamped));
  writeFileSync(statePath, "proj\therdr\tstamped\tp1\nother\therdr\tidle-clean\tp2\n");
  const stale3 = scan();
  ok("a crew row alone keeps an old seat", !stale3.plan.some(p => p.path === stamped)
    && stale3.kept.some(k => k.path === stamped && k.reason.includes("crew state row")));
  ok("the same persona in another project does not hold this seat", stale3.plan.some(p => p.path === idle));
  const stampPath = join(HOME, ".agent-bus", "turnstamp-idle-clean-proj.json");
  writeFileSync(stampPath, "{}");
  utimesSync(stampPath, new Date(NOW), new Date(NOW));
  ok("fresh turnstamp does not replace crew liveness", scan().plan.some(p => p.path === idle));
  const unrelated = makeExec({ psLines: [`200 1 /bin/sh ${idle}/some-server`] }).exec;
  ok("a path mentioned by an unrelated process does not become crew liveness", scan(unrelated).plan.some(p => p.path === idle));
  const missingPs = (file, args) => file === "ps" ? { stdout: "", status: 1 } : exec(file, args);
  ok("failed process lookup keeps worktrees", scan(missingPs).plan.length === 0);
  const seatsDir = join(HOME, ".agent-bus", "seats");
  mkdirSync(seatsDir, { recursive: true });
  writeFileSync(join(seatsDir, "proj-idle-clean.runner.json"), JSON.stringify({ label: "promoted", dir: "/fixture/source" }));
  const promoted = makeExec({ psLines: ["300 1 node /fixture/crew-runner.mjs promoted /fixture/source", "301 300 worker"] }).exec;
  ok("a promoted runner record keeps the seat without a crew row", !scan(promoted).plan.some(p => p.path === idle));
  const source = makeExec({ psLines: ["400 1 node /fixture/crew-runner.mjs live /fixture/main"] }).exec;
  const sourceExec = (file, args) => file === "git" && args.includes("list")
    ? { stdout: "worktree /fixture/main\n", status: 0 } : source(file, args);
  ok("an ordinary runner is found by its source checkout", !scan(sourceExec).plan.some(p => p.path === live));

  // ---- scanNestedBuildOutput ----
  console.log("\nscanNestedBuildOutput finds DerivedData/xcresult/target inside scratch:");
  const nested = scanNestedBuildOutput({ fs: nodeFs, exec, home: HOME, now: NOW, worktreesRoot: ROOT, entryBudget: 50_000 });
  const nPlanned = nested.plan.map((p) => p.path);
  ok("nested DerivedData older than 3d is planned", nPlanned.includes(dd), JSON.stringify(nPlanned));
  ok("nested *.xcresult older than 3d is planned", nPlanned.includes(xcr));
  ok("fresh nested DerivedData is kept", nested.kept.some((k) => k.path === ddFresh));
  ok("top-level DerivedData is NOT planned here (the 2d scratch rule owns it)", !nPlanned.includes(ddTop));
  ok("git-tracked nested target is kept", nested.kept.some((k) => k.path === ddTracked && k.reason.includes("git-tracked")));
  ok("nothing under the live seat is planned", !nPlanned.some((p) => p.startsWith(live)));

  // ---- buildDiskReport integrates both scans ----
  console.log("\nbuildDiskReport carries the new plan types and keeps:");
  const report = buildDiskReport({ exec, home: HOME, now: NOW, worktreesRoot: ROOT, entryBudget: 50_000 });
  ok("report plan includes the seat-worktree item", report.plan.some((p) => p.type === "seat-worktree" && p.path === idle));
  ok("report plan includes the build-output items", report.plan.filter((p) => p.type === "build-output").length === 2);
  ok("report kept names the dirty worktree", report.kept.some((k) => k.path === dirty && k.reason.includes("uncommitted changes")));
  const human = formatHuman(report);
  ok("the human report prints the dirty worktree by name", human.includes(dirty) && human.includes("uncommitted changes"));
  const onDisk = report.plan.filter((p) => ["build-dir", "scratch-entry", "seat-worktree", "build-output"].includes(p.type));
  ok("freedOnDiskBytes counts every on-disk plan item",
    freedOnDiskBytes(report.plan) === onDisk.reduce((n, p) => n + (p.bytes || 0), 0),
    String(freedOnDiskBytes(report.plan)));
  ok("freedOnDiskBytes includes the pruned worktree's bytes",
    freedOnDiskBytes(report.plan) >= report.plan.find((p) => p.type === "seat-worktree").bytes);

  // ---- runClean ----
  console.log("\nrunClean prints before removing and respects the belts:");
  const removed = [];
  const events = [];
  const cleanExec = makeExec({ dirty: {} }).exec;
  const results = await runClean(
    { plan: [
      { type: "seat-worktree", path: idle, project: "proj", seat: "idle-clean", bytes: 2048 },
      { type: "seat-worktree", path: join(HOME, "outside", "escape"), bytes: 1 },
      { type: "build-output", path: dd, bytes: 4096 },
    ] },
    { exec: cleanExec, home: HOME, now: NOW, worktreesRoot: ROOT,
      remove: (p) => { events.push(["rm", p]); removed.push(p); }, log: (l) => events.push(["log", l]) },
  );
  const logIdx = events.findIndex((e) => e[0] === "log" && e[1].includes(idle));
  const rmIdx = events.findIndex((e) => e[0] === "rm");
  ok("the print line lands before any removal", logIdx !== -1 && rmIdx !== -1 && logIdx < rmIdx, JSON.stringify(events));
  ok("the print line names type, path and size", /removing seat-worktree.*\(~2 KB\)/.test(events[logIdx]?.[1] || ""), events[logIdx]?.[1]);
  ok("a path outside the worktrees root is refused", results.some((r) => !r.ok && r.path?.includes("outside") && r.error.includes("not under")));
  ok("nothing outside the root was removed", !removed.some((p) => p.includes("outside")));
  ok("exactly one seat-worktree item removed ok", results.filter((r) => r.ok && r.type === "seat-worktree").length === 1, JSON.stringify(results));
  ok("build-output is removed via the injected remove", removed.includes(dd));

  console.log("\nrunClean refuses a worktree that turned dirty between scan and clean:");
  const dirtyExec = makeExec({ dirty: { [idle]: " M src/a.js" } }).exec;
  const results2 = await runClean(
    { plan: [{ type: "seat-worktree", path: idle, project: "proj", seat: "idle-clean", bytes: 2048 }] },
    { exec: dirtyExec, home: HOME, now: NOW, worktreesRoot: ROOT, remove: () => { throw new Error("must not be called"); }, log: () => {} },
  );
  ok("the re-check fails the item with the dirty reason", results2.length === 1 && !results2[0].ok && results2[0].error.includes("uncommitted changes"), JSON.stringify(results2));

  console.log("\nrunClean checks crew ownership again before each on-disk deletion:");
  const racePlan = [
    { type: "seat-worktree", path: idle },
    { type: "build-dir", path: join(idle, "target") },
    { type: "scratch-entry", path: join(idle, ".agent-bus-out", "build") },
    { type: "build-output", path: dd },
  ];
  writeFileSync(statePath, "proj\therdr\tidle-clean\tnew-pane\n");
  const rowRace = await runClean({ plan: racePlan }, {
    exec: cleanExec, home: HOME, now: NOW, log: () => {},
    remove: () => { throw new Error("must not remove a registered seat"); },
  });
  ok("a newly registered seat keeps its worktree and all output", rowRace.length === 4
    && rowRace.every(r => !r.ok && r.error.includes("crew state row")));
  writeFileSync(statePath, "");
  const processRace = await runClean({ plan: racePlan }, {
    exec: promoted, home: HOME, now: NOW, log: () => {},
    remove: () => { throw new Error("must not remove a running seat"); },
  });
  ok("a restarted runner keeps its worktree and all output", processRace.length === 4
    && processRace.every(r => !r.ok && r.error.includes("live crew processes")));

  // ---- runDisk --dry-run never cleans ----
  console.log("\nrunDisk: --dry-run wins over --clean:");
  const noRemove = () => { throw new Error("dry-run must not remove"); };
  const dry = await runDisk({ args: ["--clean", "--dry-run"], exec, home: HOME, now: NOW, worktreesRoot: ROOT, remove: noRemove, log: () => {} });
  ok("dry run reports a plan", dry.report.plan.length > 0);
  ok("dry run cleans nothing", dry.results.length === 0 && dry.clean === false);
  const wet = await runDisk({ args: ["--clean"], exec, home: HOME, now: NOW, worktreesRoot: ROOT, remove: noRemove, log: () => {} });
  ok("without --dry-run the clean runs (results recorded)", wet.clean === true && wet.results.length > 0);

  // ---- launchd plist is daily ----
  console.log("\nlaunchdPlist schedules daily and passes --daily:");
  const plist = launchdPlist({ nodePath: "/usr/bin/node", scriptPath: "/x/bin/disk.mjs", logPath: "/x/log" });
  ok("no Weekday key (every day, not just Monday)", !plist.includes("Weekday"));
  ok("runs --daily", plist.includes("--daily"));
  ok("still fires at 09:00", plist.includes("<key>Hour</key><integer>9</integer>"));

  // ---- constants ----
  ok("worktree idle window is 7 days", WORKTREE_IDLE_MAX === 7 * DAY);
  ok("build-output idle window is 3 days", BUILD_OUTPUT_IDLE_MAX === 3 * DAY);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "✅" : "❌"} worktree janitor: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
