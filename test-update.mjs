#!/usr/bin/env node
// trantor update-check tests — version self-discovery, throttled latest-lookup, update detection, and
// the once-per-version desktop-notify gating. Hermetic: RELAY_DATA_DIR points at a temp dir (seeded
// stamp = no network), and every maybeNotifyDesktop case is one that returns WITHOUT firing a real
// notification (disabled / already-notified / no-latest), so the suite never pops a system dialog.
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
console.log("# trantor update-check tests");

// Hermetic data dir — set BEFORE importing the module (it reads RELAY_DATA_DIR at import time).
const data = join(tmpdir(), "trantor-update-" + process.pid);
mkdirSync(data, { recursive: true });
process.env.RELAY_DATA_DIR = data;
const stampPath = join(data, "update-check.json");
const seedStamp = (o) => writeFileSync(stampPath, JSON.stringify(o, null, 2));
const nowSec = () => Math.floor(Date.now() / 1000);

const m = await import("./hooks/lib/update-check.mjs");

// --- semver compare ---
ok("cmpSemver: lower < higher", m.cmpSemver("0.17.25", "0.17.26") === -1);
ok("cmpSemver: equal", m.cmpSemver("0.17.26", "0.17.26") === 0);
ok("cmpSemver: minor bump dominates patch", m.cmpSemver("0.18.0", "0.17.99") === 1);
ok("cmpSemver: tolerates junk segments", m.cmpSemver("0.17", "0.17.1") === -1);

// --- installedVersion: reads this repo's own manifest ---
const inst = m.installedVersion();
ok("installedVersion resolves a real x.y.z from the plugin/package manifest", /^\d+\.\d+\.\d+/.test(inst));

// --- latestVersion: served from a FRESH cached stamp → no network ---
seedStamp({ checkedAt: nowSec(), latest: "9.9.9" });
ok("latestVersion returns the cached value when the stamp is fresh", (await m.latestVersion({})) === "9.9.9");

// --- updateAvailable: fresh stamp drives the decision (still no network) ---
seedStamp({ checkedAt: nowSec(), latest: "99.0.0" });
const upA = await m.updateAvailable({});
ok("updateAvailable: true when latest > installed", upA.available === true && upA.installed === inst && upA.latest === "99.0.0");
seedStamp({ checkedAt: nowSec(), latest: inst });
ok("updateAvailable: false when already on latest", (await m.updateAvailable({})).available === false);

// --- kill switches ---
process.env.TRANTOR_NO_UPDATE_CHECK = "1";
seedStamp({ checkedAt: nowSec(), latest: "99.0.0" });
ok("updateAvailable: disabled by TRANTOR_NO_UPDATE_CHECK", (await m.updateAvailable({})).available === false);
delete process.env.TRANTOR_NO_UPDATE_CHECK;
ok("updateAvailable: disabled by config.updateCheck:false", (await m.updateAvailable({ updateCheck: false })).available === false);

// --- maybeNotifyDesktop: only the NON-firing paths (no real system notification in tests) ---
process.env.TRANTOR_NO_UPDATE_NOTIFY = "1";
ok("notify: disabled by TRANTOR_NO_UPDATE_NOTIFY → no fire", m.maybeNotifyDesktop({ installed: inst, latest: "99.0.0" }, {}) === false);
delete process.env.TRANTOR_NO_UPDATE_NOTIFY;
ok("notify: disabled by config.updateDesktopNotify:false → no fire", m.maybeNotifyDesktop({ installed: inst, latest: "99.0.0" }, { updateDesktopNotify: false }) === false);
seedStamp({ checkedAt: nowSec(), latest: "99.0.0", notifiedVersion: "99.0.0" });
ok("notify: already-notified for this version → no re-fire (per-version throttle)", m.maybeNotifyDesktop({ installed: inst, latest: "99.0.0" }, {}) === false);
ok("notify: no latest → no fire", m.maybeNotifyDesktop({ installed: inst, latest: "" }, {}) === false);
ok("notify: did NOT overwrite the stamp on a no-fire path", JSON.parse(readFileSync(stampPath, "utf8")).notifiedVersion === "99.0.0");

// --- SessionStart hook surfaces the update as a USER-facing `systemMessage` (in-terminal),
//     NOT a desktop notification. Spawn the real hook hermetically (temp data dir + unreachable
//     hub so registration/catchup fail-silently and never touch a live hub). ---
const here = fileURLToPath(new URL(".", import.meta.url));
const hookPath = join(here, "hooks", "sessionstart.mjs");
const runHook = () => {
  const stdin = JSON.stringify({ session_id: "test", transcript_path: "/tmp/x", source: "startup", cwd: here });
  const out = execFileSync(process.execPath, [hookPath], {
    input: stdin, encoding: "utf8", timeout: 10000,
    env: { ...process.env, RELAY_DATA_DIR: data, RELAY_URL: "http://127.0.0.1:1", TRANTOR_UPDATE_TTL_H: "999", TRANTOR_NO_BALANCE_CHECK: "1" },
  });
  return JSON.parse(out);
};

seedStamp({ checkedAt: nowSec(), latest: "99.0.0" });            // update pending
const fired = runHook();
ok("sessionstart: emits a user-facing systemMessage when an update is available",
   typeof fired.systemMessage === "string" && /update available/i.test(fired.systemMessage) && fired.systemMessage.includes("99.0.0"));
ok("sessionstart: model still gets the <trantor-update> context block",
   /<trantor-update/.test(fired.hookSpecificOutput?.additionalContext || ""));

seedStamp({ checkedAt: nowSec(), latest: inst });               // already on latest
const quiet = runHook();
ok("sessionstart: NO systemMessage when already on latest", !("systemMessage" in quiet));
ok("sessionstart: NO <trantor-update> block when already on latest",
   !/<trantor-update/.test(quiet.hookSpecificOutput?.additionalContext || ""));

// cleanup
rmSync(data, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
