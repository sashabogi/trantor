// Regression for #5998: `trantor provider add --help` treated the flag as a provider NAME — wrote a
// '--help' provider into ~/.agent-bus/profile.json and a __HELP_API_KEY line into ~/.agent-bus/.env,
// then printed "Seat ready." Any name-position argument that is flag-like ("--…") or the literal
// 'help' must print the usage line and exit 1 WITHOUT touching profile.json, .env or opencode.json.
// Same guard on `provider remove` and `profile set`. Hermetic: a fake $HOME per block, so the
// writes (and the refusal to write) land in a temp dir.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
let fail = 0; const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };

const run = (bin, args, home, env = {}) => spawnSync(process.execPath, [join(ROOT, "bin", bin), ...args], {
  encoding: "utf8",
  env: { ...drillEnv(), HOME: home, ...env },
});

// --- provider add/remove: flags and 'help' in the name position die before any write ---
const H1 = mkdtempSync(join(tmpdir(), "trantor-prov-"));
for (const bad of [
  ["add", "--help"],
  ["add", "--help", "--key", "sk-should-never-be-written"],
  ["add", "help"],
  ["remove", "--help"],
  ["remove", "help"],
]) {
  const r = run("provider.mjs", bad, H1);
  ok(r.status === 1, `provider ${bad.slice(0, 2).join(" ")}: exit 1 (got ${r.status})`);
  ok(`${r.stderr}${r.stdout}`.includes("usage:"), `provider ${bad.slice(0, 2).join(" ")}: prints the usage line`);
}
ok(!existsSync(join(H1, ".agent-bus", "profile.json")), "provider guard: profile.json never created");
ok(!existsSync(join(H1, ".agent-bus", ".env")), "provider guard: .env never created");
ok(!existsSync(join(H1, ".config", "opencode", "opencode.json")), "provider guard: opencode.json never created");

// Positive control: a REAL name still works end to end — the guard sits exactly at flag-like
// names, it does not neuter the add path.
const H2 = mkdtempSync(join(tmpdir(), "trantor-prov-ok-"));
const good = run("provider.mjs", ["add", "zzz-lab", "--key", "sk-lab-123"], H2);
ok(good.status === 0, `provider add zzz-lab: exit 0 (got ${good.status})`);
ok((good.stdout ?? "").includes("Seat ready"), "provider add zzz-lab: prints Seat ready");
const prof2 = JSON.parse(readFileSync(join(H2, ".agent-bus", "profile.json"), "utf8"));
ok(prof2.providers["zzz-lab"]?.plan === "api", "provider add zzz-lab: profile.json gained zzz-lab=api");
ok(readFileSync(join(H2, ".agent-bus", ".env"), "utf8").includes("ZZZ_LAB_API_KEY=sk-lab-123"),
  "provider add zzz-lab: .env gained ZZZ_LAB_API_KEY");

// --- profile set: the same guard on the provider position ---
const H3 = mkdtempSync(join(tmpdir(), "trantor-prof-"));
for (const bad of [["set", "--help=api"], ["set", "--help"], ["set", "help=api"]]) {
  const r = run("profile.mjs", bad, H3);
  ok(r.status === 1, `profile ${bad.join(" ")}: exit 1 (got ${r.status})`);
  ok(`${r.stderr}${r.stdout}`.includes("provider=plan"), `profile ${bad.join(" ")}: usage line`);
}
ok(!existsSync(join(H3, ".agent-bus", "profile.json")), "profile guard: profile.json never created");

// Positive control: a real provider=plan still writes.
const goodSet = run("profile.mjs", ["set", "claude=max"], H3);
ok(goodSet.status === 0, `profile set claude=max: exit 0 (got ${goodSet.status})`);
const prof3 = JSON.parse(readFileSync(join(H3, ".agent-bus", "profile.json"), "utf8"));
ok(prof3.providers.claude?.plan === "max", "profile set claude=max: written to profile.json");

// --- provider remove positive control: a seeded provider is still removable ---
const H4 = mkdtempSync(join(tmpdir(), "trantor-prov-rm-"));
mkdirSync(join(H4, ".agent-bus"), { recursive: true });
writeFileSync(join(H4, ".agent-bus", "profile.json"),
  JSON.stringify({ providers: { "zzz-lab": { plan: "api", tier: "api" } } }, null, 2));
const rm = run("provider.mjs", ["remove", "zzz-lab"], H4);
ok(rm.status === 0, `provider remove zzz-lab: exit 0 (got ${rm.status})`);
const prof4 = JSON.parse(readFileSync(join(H4, ".agent-bus", "profile.json"), "utf8"));
ok(!prof4.providers["zzz-lab"], "provider remove zzz-lab: dropped from profile");

// The Accounts pane promises that Remove clears native system credentials too. A fake Codex CLI
// proves the exact logout invocation without touching the operator's real ~/.codex/auth.json.
const H5 = mkdtempSync(join(tmpdir(), "trantor-prov-logout-"));
const fakeBin = join(H5, "bin");
const logoutLog = join(H5, "codex.log");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(join(fakeBin, "codex"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logoutLog}"\n`);
chmodSync(join(fakeBin, "codex"), 0o755);
const nativeRemove = run("provider.mjs", ["remove", "codex", "--credentials"], H5, { PATH: `${fakeBin}:/usr/bin:/bin` });
ok(nativeRemove.status === 0, `provider remove codex --credentials: exit 0 (got ${nativeRemove.status})`);
ok(readFileSync(logoutLog, "utf8").trim() === "logout", "provider remove codex --credentials: invokes codex logout");
ok(nativeRemove.stdout.includes("signed out of the Codex system login"), "provider remove codex --credentials: reports native logout");

// A successful native login restores the quota declaration that Accounts → Remove deletes. The
// fake CLI keeps this hermetic: no operator login or credential is touched.
const H6 = mkdtempSync(join(tmpdir(), "trantor-prov-login-"));
const loginBin = join(H6, "bin");
mkdirSync(loginBin, { recursive: true });
writeFileSync(join(loginBin, "codex"), "#!/bin/sh\nexit 0\n");
chmodSync(join(loginBin, "codex"), 0o755);
const nativeLogin = run("provider.mjs", ["login", "codex"], H6, { PATH: `${loginBin}:/usr/bin:/bin` });
ok(nativeLogin.status === 0, `provider login codex: exit 0 (got ${nativeLogin.status})`);
const prof6 = JSON.parse(readFileSync(join(H6, ".agent-bus", "profile.json"), "utf8"));
ok(prof6.providers.codex?.plan === "subscription" && prof6.providers.codex?.tier === "capped-sub",
  "provider login codex: successful login re-declares codex in the quota profile");

const H7 = mkdtempSync(join(tmpdir(), "trantor-prov-login-fail-"));
const failingBin = join(H7, "bin");
mkdirSync(failingBin, { recursive: true });
writeFileSync(join(failingBin, "codex"), "#!/bin/sh\nexit 23\n");
chmodSync(join(failingBin, "codex"), 0o755);
const failedLogin = run("provider.mjs", ["login", "codex"], H7, { PATH: `${failingBin}:/usr/bin:/bin` });
ok(failedLogin.status === 1, `provider login codex: failed native login exits 1 (got ${failedLogin.status})`);
ok(!existsSync(join(H7, ".agent-bus", "profile.json")), "provider login codex: failed login does not declare a profile entry");

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
