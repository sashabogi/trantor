#!/usr/bin/env node
// trantor app — install/update the Trantor DESKTOP APP (Tauri) from GitHub Releases.
//
// The npm package deliberately does NOT ship desktop/ (a 6MB DMG has no business in node_modules);
// the app travels as a GitHub Release asset instead. This command is the whole distribution story
// for a teammate: `npm i -g trantor && trantor app install` → latest DMG lands in /Applications.
//
//   trantor app            status: installed version vs latest release
//   trantor app install    download the latest release DMG and install to /Applications
//   trantor app update     same as install (re-pulls whatever is latest)
//
// Release side (maintainer): build the DMG (cd desktop && npm run tauri build), then
//   gh release create app-v<ver> desktop/src-tauri/target/release/bundle/dmg/Trantor_<ver>_aarch64.dmg
// Any release whose assets include a Trantor_*.dmg is an app release; the newest one wins, so app
// releases interleave freely with code (npm) releases.
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = "sashabogi/trantor";
const APP = "/Applications/Trantor.app";
const ARCH_TAG = process.arch === "arm64" ? "aarch64" : "x64";
const cmd = process.argv[2] || "status";

if (process.platform !== "darwin") { console.error("trantor app: the desktop app is macOS-only for now"); process.exit(1); }
if (!["status", "install", "update"].includes(cmd)) {
  console.error("usage: trantor app [status|install|update]"); process.exit(1);
}

function sh(file, args) { return execFileSync(file, args, { encoding: "utf8" }); }

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
try {
  // -nobrowse keeps the volume out of Finder; mount point is the last tab-field of the last line.
  const out = sh("hdiutil", ["attach", "-nobrowse", "-readonly", dmg]);
  mount = (out.trim().split("\n").pop() || "").split("\t").pop().trim();
  const src = join(mount, "Trantor.app");
  if (!mount.startsWith("/Volumes/") || !existsSync(src)) throw new Error(`unexpected DMG layout (mount: ${mount || "none"})`);
  if (existsSync(APP)) { console.log(`replacing ${APP} (was ${have || "unknown"})`); rmSync(APP, { recursive: true, force: true }); }
  sh("ditto", [src, APP]);
  // The download carries quarantine; the user explicitly asked for this install — clear it so
  // Gatekeeper doesn't refuse the unsigned build on first launch.
  try { sh("xattr", ["-dr", "com.apple.quarantine", APP]); } catch {}
  console.log(`✓ Trantor.app ${installedVersion() || rel.version} installed → ${APP}`);
} catch (e) {
  console.error(`install failed: ${e.message}`); process.exitCode = 1;
} finally {
  if (mount) try { sh("hdiutil", ["detach", mount, "-quiet"]); } catch {}
  try { rmSync(dmg, { force: true }); } catch {}
}
