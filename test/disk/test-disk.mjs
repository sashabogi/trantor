#!/usr/bin/env node
// trantor disk tests — temp HOME, injected exec, recording remove: no real
// simctl, opencode, docker, launchctl, and no deletion outside the temp dir.
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync, realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUnderHome, buildDiskReport, runClean, runDisk, formatHuman,
  launchdPlist, fmtBytes, dirSize, gitTracked, DAY,
} from "../../lib/disk.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

console.log("# trantor disk tests");

// realpath first: on macOS tmpdir() hands out /var/... which resolves to /private/var/...,
// and assertUnderHome's resolve() would otherwise hand back paths that fail startsWith(HOME).
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "trantor-disk-home-")));
const NOW = 1_800_000_000_000; // fixed clock: every idle computation is exact
try {
  // ---- fixture: two seat worktrees, one dead one live; a git-tracked build dir ----
  const dead = join(HOME, ".agent-bus", "worktrees", "proj", "dead-seat");
  const live = join(HOME, ".agent-bus", "worktrees", "proj", "live-seat");
  const tracked = join(HOME, ".agent-bus", "worktrees", "proj", "tracked-seat");
  for (const wt of [dead, live, tracked]) {
    mkdirSync(join(wt, ".next", "cache"), { recursive: true });
    writeFileSync(join(wt, ".next", "cache", "f.js"), "x".repeat(1024));
  }
  mkdirSync(join(dead, "target", "debug"), { recursive: true });
  writeFileSync(join(dead, "target", "debug", "bin"), "y".repeat(2048));
  mkdirSync(join(tracked, "target"), { recursive: true });
  writeFileSync(join(tracked, "target", "keep.js"), "z");

  // ---- HF cache fixture: shared-blob layout, the real weights at the end of
  // snapshot symlinks; a per-model blob, a second rev re-linking the same blob, a
  // second model sharing the same big blob, and a broken symlink to survive.
  const HUB = join(HOME, ".cache", "huggingface", "hub");
  const BLOB64 = "a".repeat(64);
  mkdirSync(join(HUB, "blobs", "4f"), { recursive: true });
  writeFileSync(join(HUB, "blobs", "4f", BLOB64), "B".repeat(7 * 1024 * 1024));
  const m1 = join(HUB, "models--org--m1");
  const rev1 = join(m1, "snapshots", "rev1");
  mkdirSync(rev1, { recursive: true });
  mkdirSync(join(m1, "blobs"), { recursive: true });
  writeFileSync(join(m1, "blobs", "cfg"), "cfg!");
  symlinkSync(join("..", "..", "..", "blobs", "4f", BLOB64), join(rev1, "weights.safetensors"), "file");
  symlinkSync(join("..", "blobs", "cfg"), join(rev1, "config.json"), "file");
  symlinkSync(join("..", "blobs", "missing"), join(rev1, "broken.bin"), "file");
  const rev2 = join(m1, "snapshots", "rev2");
  mkdirSync(rev2, { recursive: true });
  symlinkSync(join("..", "..", "..", "blobs", "4f", BLOB64), join(rev2, "weights.safetensors"), "file");
  const m2 = join(HUB, "models--org--m2");
  const m2snap = join(m2, "snapshots", "r");
  mkdirSync(m2snap, { recursive: true });
  symlinkSync(join("..", "..", "..", "blobs", "4f", BLOB64), join(m2snap, "weights.safetensors"), "file");
  const HF_TOTAL = 7 * 1024 * 1024 + 4; // shared big blob + per-model config, each once

  const opencodeJson = JSON.stringify([
    { id: "ses_old", title: "old", updated: NOW - 20 * DAY, directory: join(HOME, "elsewhere") },
    { id: "ses_fresh", title: "fresh", updated: NOW - 2 * DAY, directory: join(HOME, "elsewhere") },
    { id: "ses_livewt", title: "in live seat", updated: NOW - 30 * DAY, directory: live },
  ]);
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    const a = args.join(" ");
    if (file === "ps") return { stdout: `node crew-runner ${live}\n/portless serve ${live}\n`, status: 0 };
    if (file === "opencode" && a.includes("list")) return { stdout: opencodeJson, status: 0 };
    if (file === "xcrun") return { stdout: "-- iOS 17.2 --\n    iPhone (AAA) (Shutdown)\n-- Unavailable: iOS 15.4 --\n    iPhone (BBB) (Shutdown)\n    iPad (CCC) (Shutdown)\n", status: 0 };
    if (file === "git") return { stdout: a.includes(" target") && a.includes("tracked-seat") ? "target/keep.js\n" : "", status: 0 };
    return { stdout: "", status: 1 }; // docker etc. — not running in this fixture
  };
  const removed = [];
  const remove = (p, opts) => { removed.push(p); rmSync(p, opts); };
  const d = { exec, remove, home: HOME, now: NOW };

  // ---- report mode: the plan is built, nothing is deleted ----
  const report = buildDiskReport(d);
  const planPaths = report.plan.filter((p) => p.type === "build-dir").map((p) => p.path);
  const planSessions = report.plan.filter((p) => p.type === "opencode-session").map((p) => p.id);
  ok("dead seat's .next is planned for deletion", planPaths.includes(join(dead, ".next")), JSON.stringify(planPaths));
  ok("dead seat's target is planned for deletion", planPaths.includes(join(dead, "target")));
  ok("live seat's .next is never planned", !planPaths.some((p) => p.startsWith(live)));
  ok("git-tracked target is never planned", !planPaths.some((p) => p === join(tracked, "target")));
  ok("only the idle >14d session is planned", JSON.stringify(planSessions) === JSON.stringify(["ses_old"]), JSON.stringify(planSessions));
  ok("session inside a live seat worktree is KEPT with a reason", report.kept.some((k) => k.path === live && /ses_livewt/.test(k.reason)));
  ok("live seat .next listed as KEPT", report.kept.some((k) => k.path === join(live, ".next")));
  ok("tracked target listed as KEPT", report.kept.some((k) => k.path === join(tracked, "target") && /git-tracked/.test(k.reason)));
  ok("unavailable simulators counted from simctl output", report.simulators.unavailable === 2 && report.simulators.available);
  ok("simulators are one plan entry", report.plan.filter((p) => p.type === "simulators").length === 1);
  ok("HF model sizes resolve snapshot symlinks to the blobs, deduped",
    report.hf.models.find((m) => m.model === "models--org--m1")?.bytes === HF_TOTAL,
    JSON.stringify(report.hf.models));
  ok("HF cache total counts a blob shared across models once",
    report.hf.totalBytes === HF_TOTAL && report.hf.models.find((m) => m.model === "models--org--m2")?.bytes === 7 * 1024 * 1024,
    JSON.stringify({ totalBytes: report.hf.totalBytes, models: report.hf.models }));
  ok("report mode performed zero deletions and zero clean calls",
    removed.length === 0
    && !calls.some((c) => c.join(" ") === "xcrun simctl delete unavailable")
    && !calls.some((c) => c.join(" ") === "opencode session delete ses_old"));

  const human = formatHuman(report);
  ok("drill: free space, category sizes and the exact deletion list print", human.includes("free of") && human.includes("safe tier would delete") && human.includes("dead-seat"));
  ok("drill: KEPT lines carry their reasons", /KEPT: .*live seat process/.test(human) && /KEPT: .*git-tracked/.test(human));
  ok("drill: KEPT lines name the path, same as DELETE", human.includes(`KEPT: a live seat process uses this worktree  ${join(live, ".next")}`));
  ok("drill: HF cache header is formatted, not a raw byte count",
    human.includes(`huggingface cache: ${fmtBytes(HF_TOTAL)}`) && !human.includes(`huggingface cache: ${HF_TOTAL}`));

  // ---- clean mode: only the plan executes, only under the temp HOME ----
  const results = await runClean(report, d);
  ok("clean removed dead-seat build dirs only",
    !existsSync(join(dead, ".next")) && !existsSync(join(dead, "target"))
    && !existsSync(join(tracked, ".next"))
    && existsSync(join(live, ".next")) && existsSync(join(tracked, "target")));
  ok("every removal path was asserted under the temp HOME", removed.length === 3 && removed.every((p) => p.startsWith(HOME)));
  ok("simulators deleted via the official CLI", calls.some((c) => c.join(" ") === "xcrun simctl delete unavailable"));
  ok("session deleted via the official CLI", calls.some((c) => c.join(" ") === "opencode session delete ses_old"));
  ok("fresh session untouched", !calls.some((c) => c.join(" ").includes("ses_fresh")));
  ok("results report per-item success", results.length === 5 && results.every((r) => r.ok), JSON.stringify(results));

  // ---- the under-$HOME gate refuses escapes ----
  let refused = false;
  try { assertUnderHome(join(tmpdir(), "not-under-home"), HOME); } catch { refused = true; }
  ok("assertUnderHome throws for paths outside $HOME", refused);
  ok("assertUnderHome survives a .. escape attempt", assertUnderHome(join(HOME, "a", "..", "b"), HOME) === join(HOME, "b"));

  // ---- runDisk end-to-end in report mode (args gate the clean) ----
  const run = await runDisk({ ...d, args: [] });
  ok("runDisk without --clean never cleans", run.results.length === 0 && removed.length === 3);

  // ---- launchd plist is Monday 09:00 running --weekly ----
  const plist = launchdPlist({ nodePath: "/usr/local/bin/node", scriptPath: "/x/bin/disk.mjs", logPath: "/x/log" });
  ok("plist fires Weekday 1 at 09:00 with --weekly", plist.includes("<key>Weekday</key><integer>1</integer>") && plist.includes("<key>Hour</key><integer>9</integer>") && plist.includes("--weekly"));

  // ---- guards: dirSize ignores symlinked dirs, gitTracked reads git ----
  const symW = mkdtempSync(join(tmpdir(), "trantor-disk-sym-"));
  writeFileSync(join(symW, "f.txt"), "12345");
  try { symlinkSync(HOME, join(symW, "link"), "dir"); } catch {}
  const symSize = dirSize(await import("node:fs"), symW);
  rmSync(symW, { recursive: true, force: true });
  ok("dirSize skips symlinks", symSize.bytes === 5 && existsSync(HOME));
  ok("gitTracked reads git, not assumptions", gitTracked(exec, tracked, "target") === true && gitTracked(exec, dead, ".next") === false);
  ok("fmtBytes stays human", fmtBytes(Number((1.5 * 1024 ** 3).toFixed(0))) === "1.5 GB" && fmtBytes(999) === "999 B");
  ok("build-dir sizes are measured", report.plan.find((p) => p.path === join(dead, "target"))?.bytes === 2048);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
