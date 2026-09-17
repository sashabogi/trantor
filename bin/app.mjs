#!/usr/bin/env node
// trantor app — install/update the Trantor DESKTOP APP (Tauri) from GitHub Releases. The npm
// package does not ship desktop/ (a 6MB DMG has no business in node_modules); the app travels as
// a GitHub Release asset, so `npm i -g trantor && trantor app install` is the whole story.

// Release side (maintainer): build the DMG (cd desktop && npm run tauri build), then
//   gh release create app-v<ver> desktop/src-tauri/target/release/bundle/dmg/Trantor_<ver>_aarch64.dmg
// Any release whose assets include a Trantor_*.dmg is an app release; the newest one wins.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanLaunchEnv } from "../lib/launch-env.mjs";

const REPO = "sashabogi/trantor";
const APP = "/Applications/Trantor.app";
const ARCH_TAG = process.arch === "arm64" ? "aarch64" : "x64";
const cmd = process.argv[2] || "status";

if (process.platform !== "darwin") { console.error("trantor app: the desktop app is macOS-only for now"); process.exit(1); }
if (!["status", "install", "update"].includes(cmd)) {
  console.error([
    "usage: trantor app [status|install|update]",
    "  status   installed version vs latest release (default)",
    "  install  download the latest release DMG and install to /Applications",
    "  update   same as install, then relaunch the app from a clean env",
  ].join("\n"));
  process.exit(1);
}

function sh(file, args) { return execFileSync(file, args, { encoding: "utf8" }); }

function appRunning() {
  try { return sh("/usr/bin/pgrep", ["-x", "Trantor"]).trim() !== ""; }
  catch { return false; }
}

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// `open` hands the caller's environment to the app, so an update run from a badged crew pane would
// badge every child the new app spawns and its hand-offs would reattach to the wrong project (#7414).
function relaunch(wasRunning) {
  if (wasRunning) {
    try { sh("/usr/bin/osascript", ["-e", 'tell application "Trantor" to quit']); } catch {}
    const deadline = Date.now() + 10000;
    while (appRunning() && Date.now() < deadline) pause(200);
    if (appRunning()) { try { sh("/usr/bin/pkill", ["-x", "Trantor"]); } catch {} pause(500); }
  }
  const child = spawn("/usr/bin/open", ["-a", APP], { env: cleanLaunchEnv(), stdio: "ignore", detached: true });
  child.on("error", e => console.error(`relaunch failed: ${e.message}`));
  child.unref();
  console.log(`↻ ${wasRunning ? "quit the old app and " : ""}launched ${APP} from a clean env`);
}

function installedVersion() {
  try { return sh("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(APP, "Contents/Info.plist")]).trim(); }
  catch { return ""; }
}

// Newest release carrying a Trantor DMG for this arch (falls back to any Trantor DMG — old
// releases may predate multi-arch naming). GITHUB_TOKEN is honored but not required (public repo).
async function latestAppRelease() {
  // cache-control: GitHub serves unauthenticated API responses through a shared ~60s cache — a
  // release published seconds ago comes back MISSING and `app update` re-installs the previous
  // version (observed live on the 0.2.0 release). no-cache punches through it.
  const headers = { accept: "application/vnd.github+json", "user-agent": "trantor-app", "cache-control": "no-cache" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`GitHub API ${r.status} — ${(await r.text()).slice(0, 200)}`);
  const isDmg = a => /^Trantor[_-].*\.dmg$/.test(a.name);
  for (const rel of await r.json()) {
    const assets = (rel.assets || []).filter(isDmg);
    if (!assets.length) continue;
    const asset = assets.find(a => a.name.includes(`_${ARCH_TAG}`)) || assets[0];
    if (!asset.name.includes(`_${ARCH_TAG}`)) console.error(`⚠ no ${ARCH_TAG} build in ${rel.tag_name} — using ${asset.name} (may not run on this Mac)`);
    const version = (asset.name.match(/[_-]([0-9]+(?:\.[0-9]+)*)[_-]/) || [])[1] || rel.tag_name.replace(/^app-v?|^v/, "");
    return { tag: rel.tag_name, version, asset };
  }
  throw new Error("no release with a Trantor DMG asset found");
}

const rel = await latestAppRelease().catch(e => { console.error(`trantor app: ${e.message}`); process.exit(1); });
const have = installedVersion();

if (cmd === "status") {
  console.log(`installed: ${have ? `${have} (${APP})` : "not installed"}`);
  console.log(`latest:    ${rel.version} (${rel.tag} · ${rel.asset.name})`);
  console.log(have === rel.version ? "up to date." : `run \`trantor app install\` to get ${rel.version}.`);
  process.exit(0);
}

console.log(`↓ ${rel.asset.name} (${(rel.asset.size / 1e6).toFixed(1)}MB) from ${rel.tag}…`);
const dmg = join(tmpdir(), rel.asset.name);
const dl = await fetch(rel.asset.browser_download_url, { headers: { "user-agent": "trantor-app" }, signal: AbortSignal.timeout(300000) });
if (!dl.ok || !dl.body) { console.error(`download failed: HTTP ${dl.status}`); process.exit(1); }
await pipeline(Readable.fromWeb(dl.body), createWriteStream(dmg));

let mount = "";
let installed = false;
const wasRunning = appRunning();
try {
  // diskutil first: on macOS 26 the deprecated hdiutil shim IGNORES -nobrowse, so the mounted
  // volume popped a Finder window mid-update and read as an install prompt. Parse
  // the mount point as everything after the last " at " — volume names can contain spaces.
  try {
    // real output (verified live): tab-separated, same shape as hdiutil —
    // "/dev/disk12s1\tApple_HFS            \t/Volumes/Trantor" — last tab field is the mount.
    const out = sh("diskutil", ["image", "attach", "--mountOptions", "nobrowse", "--readOnly", dmg]);
    const line = out.trim().split("\n").filter(l => l.includes("/Volumes/")).pop() || "";
    mount = line.split("\t").pop().trim();
    if (!mount.startsWith("/Volumes/")) throw new Error("no mount point in diskutil output");
  } catch {
    // older macOS: the original hdiutil path, tab-field parse (robust to spaces)
    const out = sh("hdiutil", ["attach", "-nobrowse", "-readonly", dmg]);
    mount = (out.trim().split("\n").pop() || "").split("\t").pop().trim();
  }
  const src = join(mount, "Trantor.app");
  if (!mount.startsWith("/Volumes/") || !existsSync(src)) throw new Error(`unexpected DMG layout (mount: ${mount || "none"})`);
  if (existsSync(APP)) { console.log(`replacing ${APP} (was ${have || "unknown"})`); rmSync(APP, { recursive: true, force: true }); }
  sh("ditto", [src, APP]);
  // The download carries quarantine; the user explicitly asked for this install — clear it so
  // Gatekeeper doesn't refuse the unsigned build on first launch.
  try { sh("xattr", ["-dr", "com.apple.quarantine", APP]); } catch {}
  console.log(`✓ Trantor.app ${installedVersion() || rel.version} installed → ${APP}`);
  installed = true;
} catch (e) {
  console.error(`install failed: ${e.message}`); process.exitCode = 1;
} finally {
  if (mount) {
    try { sh("diskutil", ["eject", mount]); }
    catch { try { sh("hdiutil", ["detach", mount, "-quiet"]); } catch {} }
  }
  try { rmSync(dmg, { force: true }); } catch {}
}
// A replaced app keeps running its deleted binary until relaunched; `update` always relaunches.
if (installed && (cmd === "update" || wasRunning)) relaunch(wasRunning);
