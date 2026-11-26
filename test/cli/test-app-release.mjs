#!/usr/bin/env node
// Regression: `trantor app update` and the desktop update check took the FIRST release GitHub
// listed, but GitHub sorts tag names as text, so on 2026-11-26 app-v2.1.10 came back after app-v2.1.2
// and a 2.1.9 install was told it was current. The newest release is the highest version.
import { newestDmgRelease, versionNewer } from "../../lib/app-release.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  cond ? pass++ : fail++;
};
const rel = (v, extra = {}) => ({ tag_name: `app-v${v}`, draft: false, assets: [{ name: `Trantor_${v}_aarch64.dmg`, browser_download_url: `https://github.com/x/${v}.dmg` }], ...extra });

// GitHub's own order that day
const listed = [rel("2.1.9"), rel("2.1.8"), rel("2.1.2"), rel("2.1.10"), rel("2.1.1"), rel("2.0.9")];
const best = newestDmgRelease(listed, "aarch64");
ok("2.1.10 wins over the first-listed 2.1.9", best?.version === "2.1.10" && best?.tag === "app-v2.1.10", JSON.stringify(best));
ok("versions compare numerically", versionNewer("2.1.10", "2.1.9") && !versionNewer("2.1.9", "2.1.10") && !versionNewer("2.1.10", "2.1.10"));
ok("a draft never counts", newestDmgRelease([rel("2.1.9"), rel("9.9.9", { draft: true })], "aarch64")?.version === "2.1.9");
ok("a release without a DMG is skipped", newestDmgRelease([{ tag_name: "v3.0.0", assets: [{ name: "notes.txt" }] }, rel("2.1.9")], "aarch64")?.version === "2.1.9");
ok("this arch's build is preferred", newestDmgRelease([{ tag_name: "app-v2.2.0", assets: [{ name: "Trantor_2.2.0_x64.dmg" }, { name: "Trantor_2.2.0_aarch64.dmg" }] }], "aarch64")?.asset.name === "Trantor_2.2.0_aarch64.dmg");
ok("nothing found is null", newestDmgRelease([], "aarch64") === null);

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
