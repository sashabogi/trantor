#!/usr/bin/env node
// trantor disk tests — temp HOME, injected exec, recording remove: no real
// simctl, opencode, docker, launchctl, and no deletion outside the temp dir.
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync, realpathSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUnderHome, buildDiskReport, runClean, runDisk, formatHuman,
  launchdPlist, fmtBytes, dirSize, gitTracked, DAY, freedOnDiskBytes,
  SCRATCH_DIRS, SCRATCH_IDLE_MAX,
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
const OLD = NOW - 3 * DAY;     // older than SCRATCH_IDLE_MAX (2d) — safely stale
// Backdate a whole tree to `t`: the age rules read max mtime over files AND dirs
// (a rename updates the dir, not the file), so every node must carry the old stamp.
function ageTree(fsmod, root, t) {
  // Date objects, never bare numbers: utimesSync reads numbers as SECONDS, and these
  // ms values clamp to the max representable timestamp — a far-future "fresh" mtime.
  utimesSync(root, new Date(t), new Date(t));
  let entries = [];
  try { entries = fsmod.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) ageTree(fsmod, p, t);
    else { try { utimesSync(p, new Date(t), new Date(t)); } catch {} }
  }
}
try {
  // ---- fixture: seat worktrees — dead, live processes, tracked, and crew-owned ----
  const dead = join(HOME, ".agent-bus", "worktrees", "proj", "dead-seat");
  const live = join(HOME, ".agent-bus", "worktrees", "proj", "live-seat");
  const tracked = join(HOME, ".agent-bus", "worktrees", "proj", "tracked-seat");
  const stamped = join(HOME, ".agent-bus", "worktrees", "proj", "stamp-seat");
  const stampLive = join(HOME, ".agent-bus", "worktrees", "proj", "stamp-live-seat");
  for (const wt of [dead, live, tracked, stamped, stampLive]) {
    mkdirSync(join(wt, ".next", "cache"), { recursive: true });
    writeFileSync(join(wt, ".next", "cache", "f.js"), "x".repeat(1024));
  }
  mkdirSync(join(dead, "target", "debug"), { recursive: true });
  writeFileSync(join(dead, "target", "debug", "bin"), "y".repeat(2048));
  mkdirSync(join(tracked, "target"), { recursive: true });
  writeFileSync(join(tracked, "target", "keep.js"), "z");
  // #11486 scratch: the contract's three shapes — an OLD entry, a FRESH one, and an OLD
  // one in a LIVE seat (only the first is ever removed). The live seat's entry is
  // deliberately backdated: liveness, not age, is what must protect it.
  mkdirSync(join(dead, ".agent-bus-out", "old-entry", "deep"), { recursive: true });
  writeFileSync(join(dead, ".agent-bus-out", "old-entry", "deep", "gate.json"), "g".repeat(512));
  mkdirSync(join(dead, ".agent-bus-out", "fresh-entry"), { recursive: true });
  writeFileSync(join(dead, ".agent-bus-out", "fresh-entry", "now.txt"), "n");
  mkdirSync(join(dead, ".scratch"), { recursive: true });
  writeFileSync(join(dead, ".scratch", "old-note.txt"), "o".repeat(256));
  writeFileSync(join(dead, ".scratch", "recent.txt"), "r");
  mkdirSync(join(live, ".agent-bus-out", "old-but-live"), { recursive: true });
  writeFileSync(join(live, ".agent-bus-out", "old-but-live", "evidence.txt"), "l");
  mkdirSync(join(stampLive, ".agent-bus-out", "old-but-fresh-stamp"), { recursive: true });
  writeFileSync(join(stampLive, ".agent-bus-out", "old-but-fresh-stamp", "midturn.bin"), "m");
  mkdirSync(join(stamped, ".agent-bus-out", "stale-stamp-scratch"), { recursive: true });
  writeFileSync(join(stamped, ".agent-bus-out", "stale-stamp-scratch", "junk.bin"), "s".repeat(128));
  // backdate everything deletable EXCEPT the live seat's fresh .next
  for (const p of [join(dead, ".next"), join(dead, "target"), join(tracked, ".next"),
    join(stamped, ".next"), join(stampLive, ".next"), join(dead, ".agent-bus-out", "old-entry"),
    join(dead, ".scratch", "old-note.txt"), join(live, ".agent-bus-out", "old-but-live"),
    join(stamped, ".agent-bus-out", "stale-stamp-scratch"),
    join(stampLive, ".agent-bus-out", "old-but-fresh-stamp")]) ageTree(await import("node:fs"), p, OLD);
  // "fresh" means NOW on the FIXED clock: real creation time drifts stale against it
  for (const p of [join(dead, ".agent-bus-out", "fresh-entry"), join(dead, ".agent-bus-out", "fresh-entry", "now.txt"),
    join(dead, ".scratch", "recent.txt"), join(live, ".next")]) ageTree(await import("node:fs"), p, NOW);
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  writeFileSync(join(HOME, ".agent-bus", "crew-windows.txt"), "proj\therdr\tstamp-live-seat\tp1\n");
  // A stamp is not crew liveness, even when it is fresh.
  const stamp = join(HOME, ".agent-bus", "turnstamp-stamp-seat-proj.json");
  writeFileSync(stamp, "{}");
  utimesSync(stamp, new Date(NOW), new Date(NOW));
  const DEAD_BYTES = 1024 + 2048 + 1024 + 1024 + 512 + 256 + 128; // every planned on-disk item

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
    if (file === "ps") return { stdout: `100 1 node /fixture/crew-runner.mjs live-seat ${live}\n101 100 /portless serve ${live}\n`, status: 0 };
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
  const scratchPaths = report.plan.filter((p) => p.type === "scratch-entry").map((p) => p.path);
  const planSessions = report.plan.filter((p) => p.type === "opencode-session").map((p) => p.id);
  ok("dead seat's .next is planned for deletion", planPaths.includes(join(dead, ".next")), JSON.stringify(planPaths));
  ok("dead seat's target is planned for deletion", planPaths.includes(join(dead, "target")));
  ok("live seat's .next is never planned", !planPaths.some((p) => p.startsWith(live)));
  ok("a fresh turn stamp does not keep an unowned dead seat live",
    planPaths.includes(join(stamped, ".next")), JSON.stringify(planPaths));
  ok("git-tracked target is never planned", !planPaths.some((p) => p === join(tracked, "target")));
  ok("only the idle >14d session is planned", JSON.stringify(planSessions) === JSON.stringify(["ses_old"]), JSON.stringify(planSessions));
  ok("the dead seat's OLD scratch entry is planned", scratchPaths.includes(join(dead, ".agent-bus-out", "old-entry")), JSON.stringify(scratchPaths));
  ok("the dead seat's OLD scratch FILE is planned", scratchPaths.includes(join(dead, ".scratch", "old-note.txt")), JSON.stringify(scratchPaths));
  ok("the FRESH scratch entry is never planned", !scratchPaths.includes(join(dead, ".agent-bus-out", "fresh-entry")));
  ok("the recent scratch file is never planned", !scratchPaths.includes(join(dead, ".scratch", "recent.txt")));
  ok("the LIVE seat's old scratch entry is never planned — liveness outranks age",
    !scratchPaths.some((p) => p.startsWith(live)), JSON.stringify(scratchPaths));
  ok("the scratch dirs themselves are never planned, only entries inside",
    !scratchPaths.some((p) => p.endsWith(".agent-bus-out") || p === join(dead, ".scratch")));
  ok("session inside a live seat worktree is KEPT with a reason", report.kept.some((k) => k.path === live && /ses_livewt/.test(k.reason)));
  ok("live seat .next listed as KEPT", report.kept.some((k) => k.path === join(live, ".next")));
  ok("a crew state row alone keeps a seat's scratch without a process",
    !report.plan.some((p) => String(p.path || "").startsWith(stampLive))
    && report.kept.some((k) => k.path === join(stampLive, ".agent-bus-out", "old-but-fresh-stamp") && /crew state row/.test(k.reason)),
    JSON.stringify(report.kept.filter((k) => k.path.startsWith(stampLive))));
  ok("live seat's old scratch is KEPT (ps liveness)",
    report.kept.some((k) => k.path === join(live, ".agent-bus-out", "old-but-live") && /live crew processes/.test(k.reason)));
  ok("tracked target listed as KEPT", report.kept.some((k) => k.path === join(tracked, "target") && /git-tracked/.test(k.reason)));
  ok("fresh scratch listed as KEPT with its age reason",
    report.kept.some((k) => k.path === join(dead, ".agent-bus-out", "fresh-entry") && /touched within/.test(k.reason)));
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
  ok("freedOnDiskBytes sums exactly the on-disk plan items",
    freedOnDiskBytes(report.plan) === DEAD_BYTES, `${freedOnDiskBytes(report.plan)} vs ${DEAD_BYTES}`);

  const human = formatHuman(report);
  ok("drill: free space, category sizes and the exact deletion list print", human.includes("free of") && human.includes("safe tier would delete") && human.includes("dead-seat"));
  ok("drill: scratch DELETE lines carry their bytes",
    human.includes(`DELETE 512 B ${join(dead, ".agent-bus-out", "old-entry")}`)
    && human.includes(`DELETE 256 B ${join(dead, ".scratch", "old-note.txt")}`),
    human.split("\n").filter((l) => l.includes("DELETE")).join(" | "));
  ok("drill: KEPT lines carry their reasons", /KEPT: .*live crew processes/.test(human) && /KEPT: .*git-tracked/.test(human));
  ok("drill: KEPT lines name the path, same as DELETE", human.includes(`KEPT: live-seat:proj has live crew processes  ${join(live, ".next")}`));
  ok("drill: HF cache header is formatted, not a raw byte count",
    human.includes(`huggingface cache: ${fmtBytes(HF_TOTAL)}`) && !human.includes(`huggingface cache: ${HF_TOTAL}`));

  // ---- clean mode: only the plan executes, only under the temp HOME ----
  const before = removed.length;
  const results = await runClean(report, d);
  ok("clean removed the dead and stale-stamp seats' build dirs only",
    !existsSync(join(dead, ".next")) && !existsSync(join(dead, "target"))
    && !existsSync(join(stamped, ".next"))
    && !existsSync(join(tracked, ".next"))
    && existsSync(join(live, ".next")) && existsSync(join(tracked, "target")));
  ok("clean removed only the OLD scratch entries",
    !existsSync(join(dead, ".agent-bus-out", "old-entry")) && !existsSync(join(dead, ".scratch", "old-note.txt"))
    && !existsSync(join(stamped, ".agent-bus-out", "stale-stamp-scratch"))
    && existsSync(join(dead, ".agent-bus-out", "fresh-entry")) && existsSync(join(dead, ".scratch", "recent.txt"))
    && existsSync(join(live, ".agent-bus-out", "old-but-live"))
    && existsSync(join(stampLive, ".agent-bus-out", "old-but-fresh-stamp")) && existsSync(join(stampLive, ".next")));
  ok("every removal path was asserted under the temp HOME", removed.length === before + 7 && removed.every((p) => p.startsWith(HOME)));
  ok("simulators deleted via the official CLI", calls.some((c) => c.join(" ") === "xcrun simctl delete unavailable"));
  ok("session deleted via the official CLI", calls.some((c) => c.join(" ") === "opencode session delete ses_old"));
  ok("fresh session untouched", !calls.some((c) => c.join(" ").includes("ses_fresh")));
  ok("results report per-item success", results.length === 9 && results.every((r) => r.ok), JSON.stringify(results));

  // ---- the under-$HOME gate refuses escapes ----
  let refused = false;
  try { assertUnderHome(join(tmpdir(), "not-under-home"), HOME); } catch { refused = true; }
  ok("assertUnderHome throws for paths outside $HOME", refused);
  ok("assertUnderHome survives a .. escape attempt", assertUnderHome(join(HOME, "a", "..", "b"), HOME) === join(HOME, "b"));

  // ---- runDisk end-to-end in report mode (args gate the clean) ----
  const run = await runDisk({ ...d, args: [] });
  ok("runDisk without --clean never cleans", run.results.length === 0 && removed.length === before + 7);

  // ---- launchd plist is daily at 09:00 ----
  const plist = launchdPlist({ nodePath: "/usr/local/bin/node", scriptPath: "/x/bin/disk.mjs", logPath: "/x/log" });
  ok("plist fires daily at 09:00 with --daily", !plist.includes("<key>Weekday</key>") && plist.includes("<key>Hour</key><integer>9</integer>") && plist.includes("--daily"));

  // ---- guards: dirSize ignores symlinked dirs, gitTracked reads git ----
  const symW = mkdtempSync(join(tmpdir(), "trantor-disk-sym-"));
  writeFileSync(join(symW, "f.txt"), "12345");
  try { symlinkSync(HOME, join(symW, "link"), "dir"); } catch {}
  const symSize = dirSize(await import("node:fs"), symW);
  rmSync(symW, { recursive: true, force: true });
  ok("dirSize skips symlinks", symSize.bytes === 5 && existsSync(HOME));
  ok("dirSize reports maxMtime over files and dirs", symSize.maxMtime > 0);
  ok("gitTracked reads git, not assumptions", gitTracked(exec, tracked, "target") === true && gitTracked(exec, dead, ".next") === false);
  ok("fmtBytes stays human", fmtBytes(Number((1.5 * 1024 ** 3).toFixed(0))) === "1.5 GB" && fmtBytes(999) === "999 B");
  ok("build-dir sizes are measured", report.plan.find((p) => p.path === join(dead, "target"))?.bytes === 2048);
  ok("scratch constants are the 2-day window over .agent-bus-out and .scratch",
    SCRATCH_IDLE_MAX === 2 * DAY && JSON.stringify(SCRATCH_DIRS) === JSON.stringify([".agent-bus-out", ".scratch"]));
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
