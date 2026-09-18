#!/usr/bin/env node
// The secret store (#6393): a key round-trips through an env-selected backend, migrate leaves
// ~/.agent-bus/.env with stubs and is idempotent, the seat shell carries the key with the store
// winning over a stale file line, and no CLI verb ever prints a value.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";
import { withEnvFiles } from "../../lib/project.mjs";
import { resolveKeys } from "../../lib/provider-keys.mjs";
import {
  openStore, putSecret, dropSecret, migrateSecrets, envFileSecrets, backendFor, resolveSecrets,
  shadowEnv, withSecretExports, stubLine, manifestPath, isSecretName,
} from "../../lib/secrets.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const fakeBus = () => { const d = mkdtempSync(join(tmpdir(), "trantor-secrets-")); mkdirSync(d, { recursive: true }); return d; };
const fileEnv = (bus) => ({ AGENT_BUS_DIR: bus, TRANTOR_SECRETS_BACKEND: "file" });
const VALUE = 'sk-dr1ll "quoted" and spaced';

console.log("# secret store: file backend round-trip");
{
  const bus = fakeBus(), env = fileEnv(bus);
  ok("a name is secret-shaped by suffix", isSecretName("ZZZ_DRILL_API_KEY") && isSecretName("RELAY_BOOTSTRAP_TOKEN") && !isSecretName("TRANTOR_STATE"));
  const put = putSecret("ZZZ_DRILL_API_KEY", VALUE, env);
  ok("putSecret reports the file backend", put.backend === "file", put.backend);
  const store = openStore(env);
  ok("get returns the exact value", store.get("ZZZ_DRILL_API_KEY") === VALUE);
  ok("names() lists it", store.names().includes("ZZZ_DRILL_API_KEY"));
  ok("values() is the env layer", resolveSecrets(env).ZZZ_DRILL_API_KEY === VALUE);
  ok("the manifest holds names only, never the value", existsSync(manifestPath(env)) && !readFileSync(manifestPath(env), "utf8").includes("sk-dr1ll"));
  ok("an unknown name is null, not a throw", store.get("ZZZ_NOPE_API_KEY") === null);
  let threw = false;
  try { store.set("not-a-name", "x"); } catch { threw = true; }
  ok("a non-env name is refused", threw);
  threw = false;
  try { store.set("ZZZ_EMPTY_API_KEY", ""); } catch { threw = true; }
  ok("an empty value is refused", threw);
  const drop = dropSecret("ZZZ_DRILL_API_KEY", env);
  ok("remove drops the name and the value", drop.removed && store.get("ZZZ_DRILL_API_KEY") === null && !store.names().length);
  ok("removing again reports nothing removed", dropSecret("ZZZ_DRILL_API_KEY", env).removed === false);
}

console.log("# backend selection");
{
  const bus = fakeBus();
  ok("TRANTOR_NO_KEYCHAIN=1 forces none", backendFor({ AGENT_BUS_DIR: bus, TRANTOR_NO_KEYCHAIN: "1", TRANTOR_SECRETS_BACKEND: "keychain" }) === "none");
  ok("an explicit file backend wins", backendFor({ AGENT_BUS_DIR: bus, TRANTOR_SECRETS_BACKEND: "file" }) === "file");
  if (process.platform === "darwin") {
    ok("darwin with no manifest is none (a fake HOME never reaches the operator keychain)", backendFor({ AGENT_BUS_DIR: bus }) === "none");
    ok("a writer asking to create gets the keychain", backendFor({ AGENT_BUS_DIR: bus }, { create: true }) === "keychain");
    writeFileSync(manifestPath({ AGENT_BUS_DIR: bus }), JSON.stringify({ version: 1, names: {} }));
    ok("darwin with a manifest is the keychain", backendFor({ AGENT_BUS_DIR: bus }) === "keychain");
  } else {
    ok("no keychain off darwin", backendFor({ AGENT_BUS_DIR: bus }, { create: true }) === "none");
  }
  ok("the none store never throws on read", resolveSecrets({ AGENT_BUS_DIR: bus, TRANTOR_NO_KEYCHAIN: "1" }).constructor === Object);
}

console.log("# migrate: stubs, flags kept, idempotent");
{
  const bus = fakeBus(), env = fileEnv(bus);
  const envFile = join(bus, ".env");
  writeFileSync(envFile, [
    "# Trantor CREW key layer.",
    "DEEPSEEK_API_KEY=sk-deep-1",
    'export QWEN_API_KEY="sk-qwen-1"',
    "TRANTOR_STATE=1",
    "ZZZ_EMPTY_TOKEN=",
    "",
  ].join("\n"));
  const dry = migrateSecrets(env, { dryRun: true });
  ok("dry run names the moves", dry.dryRun && dry.moved.join() === "DEEPSEEK_API_KEY,QWEN_API_KEY" && dry.cleared.join() === "ZZZ_EMPTY_TOKEN");
  ok("dry run writes nothing", readFileSync(envFile, "utf8").includes("sk-deep-1") && !openStore(env).names().length);
  const r = migrateSecrets(env);
  ok("moved both secrets", r.moved.join() === "DEEPSEEK_API_KEY,QWEN_API_KEY");
  ok("the flag stays", r.kept.join() === "TRANTOR_STATE");
  const after = readFileSync(envFile, "utf8");
  ok("no value survives in .env", !after.includes("sk-deep-1") && !after.includes("sk-qwen-1"));
  ok("each moved line is a comment stub", after.includes(stubLine("DEEPSEEK_API_KEY")) && after.includes(stubLine("QWEN_API_KEY")));
  ok("the empty secret line is a stub too (an empty export would shadow the store)", after.includes(stubLine("ZZZ_EMPTY_TOKEN")) && !/^ZZZ_EMPTY_TOKEN=/m.test(after));
  ok("the flag line and the header comment are byte-identical", after.includes("TRANTOR_STATE=1\n") && after.startsWith("# Trantor CREW key layer.\n"));
  ok("the store holds the values, quotes stripped", openStore(env).get("DEEPSEEK_API_KEY") === "sk-deep-1" && openStore(env).get("QWEN_API_KEY") === "sk-qwen-1");
  const again = migrateSecrets(env);
  ok("a second run moves nothing", !again.moved.length && !again.cleared.length && again.stubbed.length === 3);
  ok("…and leaves the file unchanged", readFileSync(envFile, "utf8") === after);
  const view = envFileSecrets(env);
  ok("envFileSecrets sees no live key and three stubs", !view.live.length && view.stubbed.length === 3 && view.kept.join() === "TRANTOR_STATE");
  ok("a bus dir with no .env migrates to nothing", !migrateSecrets(fileEnv(fakeBus())).moved.length);
  const stubbedBySet = putSecret("ZZZ_LATE_API_KEY", "late", env);
  writeFileSync(envFile, `${after}ZZZ_LATE_API_KEY=stale\n`);
  const put = putSecret("ZZZ_LATE_API_KEY", "late-2", env);
  ok("set stubs a live .env line for the same name", !stubbedBySet.stubbed && put.stubbed && readFileSync(envFile, "utf8").includes(stubLine("ZZZ_LATE_API_KEY")));
}

console.log("# the seat shell: the store wins over a stale file line, values never on argv");
{
  const bus = fakeBus();
  const crew = join(bus, "crew.env"), scrooge = join(bus, "scrooge.env");
  writeFileSync(crew, "DEEPSEEK_API_KEY=STALE_CREW\nCREW_ONLY=yes\n");
  writeFileSync(scrooge, "DEEPSEEK_API_KEY=SCROOGE\nSCROOGE_ONLY=yes\n");
  const values = { DEEPSEEK_API_KEY: "FROM_STORE", ZZZ_DRILL_TOKEN: VALUE };
  const probe = `printf '%s|%s|%s|%s' "$DEEPSEEK_API_KEY" "$ZZZ_DRILL_TOKEN" "$__TRANTOR_SECRET__DEEPSEEK_API_KEY" "$CREW_ONLY"`;
  const cmd = withEnvFiles(withSecretExports(probe, Object.keys(values)), [crew, scrooge]);
  ok("the command string carries names, never values", cmd.includes("__TRANTOR_SECRET__DEEPSEEK_API_KEY") && !cmd.includes("FROM_STORE") && !cmd.includes("sk-dr1ll"));
  const childEnv = drillEnv({ ...shadowEnv(values) });
  delete childEnv.DEEPSEEK_API_KEY;
  const out = execSync(cmd, { shell: "/bin/bash", encoding: "utf8", env: childEnv });
  ok("the store's key reaches the seat over both files", out.startsWith("FROM_STORE|"), out);
  ok("a quoted, spaced value survives the re-export", out.split("|")[1] === VALUE, out);
  ok("the shadow name is unset before the command runs", out.split("|")[2] === "");
  ok("the file's other lines still come through", out.endsWith("|yes"));
  ok("no store names leaves the command untouched", withSecretExports(probe, []) === probe);
  ok("a non-env name is dropped from the exports", withSecretExports(probe, ["bad-name"]) === probe);
}

console.log("# resolveKeys: store > ~/.agent-bus/.env > ~/.token-scrooge/.env > process env");
{
  const bus = fakeBus();
  const crew = join(bus, "crew.env"), scrooge = join(bus, "scrooge.env");
  writeFileSync(scrooge, "DEEPSEEK_API_KEY=SCROOGE\n");
  writeFileSync(crew, "DEEPSEEK_API_KEY=CREW\n");
  ok("without a store the crew file wins over env", resolveKeys({ DEEPSEEK_API_KEY: "ENV" }, [scrooge, crew]).DEEPSEEK_API_KEY === "CREW");
  ok("with a store the store wins", resolveKeys({ DEEPSEEK_API_KEY: "ENV" }, [scrooge, crew], { DEEPSEEK_API_KEY: "STORE" }).DEEPSEEK_API_KEY === "STORE");
  ok("a store without that key falls through to the file", resolveKeys({}, [scrooge, crew], { OTHER_API_KEY: "x" }).DEEPSEEK_API_KEY === "CREW");
}

console.log("# trantor secrets: the verbs, and no value ever printed");
{
  const bus = fakeBus();
  const env = drillEnv({ AGENT_BUS_DIR: bus, TRANTOR_SECRETS_BACKEND: "file", HOME: bus });
  const cli = (args, input) => spawnSync(process.execPath, [join(ROOT, "bin", "secrets.mjs"), ...args], { encoding: "utf8", env, input });
  const noValue = (r) => !`${r.stdout}${r.stderr}`.includes("sk-dr1ll");
  let r = cli(["set", "ZZZ_DRILL_API_KEY"], `${VALUE}\n`);
  ok("set reads stdin and exits 0", r.status === 0, r.stderr);
  ok("set never echoes the value", noValue(r));
  ok("set stored the value (one trailing newline stripped)", openStore({ AGENT_BUS_DIR: bus, TRANTOR_SECRETS_BACKEND: "file" }).get("ZZZ_DRILL_API_KEY") === VALUE);
  r = cli(["set", "ZZZ_DRILL_API_KEY"], "");
  ok("set with an empty stdin is a usage error", r.status === 1 && r.stderr.includes("usage:"));
  r = cli(["set", "--help"], "x");
  ok("set --help is a usage question, not a name", r.status === 1 && r.stderr.includes("usage:"));
  r = cli(["list"]);
  ok("list names the key and its layer", r.status === 0 && r.stdout.includes("ZZZ_DRILL_API_KEY") && r.stdout.includes("file"), r.stdout);
  ok("list never prints the value", noValue(r));
  writeFileSync(join(bus, ".env"), "ZZZ_LIVE_API_KEY=sk-dr1ll-live\n");
  r = cli(["list", "--json"]);
  const rows = JSON.parse(r.stdout).rows;
  ok("list --json marks a live .env key", rows.find((x) => x.name === "ZZZ_LIVE_API_KEY")?.envLive === true && rows.find((x) => x.name === "ZZZ_DRILL_API_KEY")?.keychain === true);
  ok("list --json never carries the value", noValue(r));
  r = cli(["migrate", "--json"]);
  const mig = JSON.parse(r.stdout);
  ok("migrate moves the live key", r.status === 0 && mig.moved.join() === "ZZZ_LIVE_API_KEY" && noValue(r));
  r = cli(["remove", "ZZZ_DRILL_API_KEY"]);
  ok("remove exits 0 and drops the key", r.status === 0 && !openStore({ AGENT_BUS_DIR: bus, TRANTOR_SECRETS_BACKEND: "file" }).has("ZZZ_DRILL_API_KEY"));
  r = cli(["bogus"]);
  ok("an unknown verb is a usage error", r.status === 1);
}

console.log("# provider add/remove go through the store once it is on");
{
  const home = fakeBus();
  const bus = join(home, ".agent-bus");
  const env = drillEnv({ HOME: home, AGENT_BUS_DIR: bus, TRANTOR_SECRETS_BACKEND: "file", PATH: "/usr/bin:/bin" });
  const run = (bin, args) => spawnSync(process.execPath, [join(ROOT, "bin", bin), ...args], { encoding: "utf8", env });
  const added = run("provider.mjs", ["add", "zzz-lab", "--key", "sk-dr1ll-lab"]);
  ok("provider add exits 0", added.status === 0, added.stderr);
  ok("the key is in the store, not in .env", openStore(env).get("ZZZ_LAB_API_KEY") === "sk-dr1ll-lab" && !(existsSync(join(bus, ".env")) && readFileSync(join(bus, ".env"), "utf8").includes("sk-dr1ll")));
  ok("provider add never prints the value", !`${added.stdout}${added.stderr}`.includes("sk-dr1ll"));
  const removed = run("provider.mjs", ["remove", "zzz-lab", "--credentials"]);
  ok("provider remove --credentials drops the store entry", removed.status === 0 && openStore(env).get("ZZZ_LAB_API_KEY") === null, removed.stderr);
  const off = drillEnv({ HOME: home, AGENT_BUS_DIR: bus, TRANTOR_NO_KEYCHAIN: "1", PATH: "/usr/bin:/bin" });
  const fileAdd = spawnSync(process.execPath, [join(ROOT, "bin", "provider.mjs"), "add", "zzz-lab", "--key", "sk-file-lab"], { encoding: "utf8", env: off });
  ok("with no store, provider add still writes .env (the fallback layer)", fileAdd.status === 0 && readFileSync(join(bus, ".env"), "utf8").includes("ZZZ_LAB_API_KEY=sk-file-lab"));
}

console.log("# doctor names a key still living in .env");
{
  const home = fakeBus();
  const bus = join(home, ".agent-bus");
  mkdirSync(bus, { recursive: true });
  writeFileSync(join(bus, ".env"), "DEEPSEEK_API_KEY=sk-dr1ll-doc\n");
  const env = drillEnv({ HOME: home, AGENT_BUS_DIR: bus, TRANTOR_SECRETS_BACKEND: "file", PATH: "/usr/bin:/bin", TRANTOR_NO_DESKTOP_NOTIFY: "1" });
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "doctor.mjs"), "--json"], { encoding: "utf8", env, maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* a doctor that cannot report fails the asserts below */ }
  const straggler = report?.issues.find((i) => i.message.includes("still live in ~/.agent-bus/.env"));
  ok("doctor warns about the straggler by name", !!straggler && straggler.message.includes("DEEPSEEK_API_KEY"), r.stdout.slice(0, 300));
  ok("…with the one command that fixes it", !!straggler && straggler.fix.includes("trantor secrets migrate"));
  ok("doctor names the .env layer as the one that answered", !!report?.ok.find((o) => o.message.startsWith("DEEPSEEK_API_KEY:") && o.message.includes("~/.agent-bus/.env (crew)")));
  ok("doctor never prints the value", !r.stdout.includes("sk-dr1ll-doc"));
  migrateSecrets(env);
  const r2 = spawnSync(process.execPath, [join(ROOT, "bin", "doctor.mjs"), "--json"], { encoding: "utf8", env, maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
  let report2 = null;
  try { report2 = JSON.parse(r2.stdout); } catch { /* same as above */ }
  ok("after migrate the straggler is gone and the store layer answers", !report2?.issues.find((i) => i.message.includes("still live")) && !!report2?.ok.find((o) => o.message.startsWith("DEEPSEEK_API_KEY:") && o.message.includes("via keychain")));
}

if (process.platform === "darwin" && existsSync("/usr/bin/security")) {
  console.log("# the real security binary on a throwaway keychain");
  const bus = fakeBus();
  const kc = join(bus, "drill.keychain-db");
  execSync(`/usr/bin/security create-keychain -p drillpw ${JSON.stringify(kc)}`);
  const env = { AGENT_BUS_DIR: bus, TRANTOR_SECRETS_BACKEND: "keychain", TRANTOR_SECRETS_KEYCHAIN: kc };
  try {
    const put = putSecret("ZZZ_DRILL_API_KEY", VALUE, env);
    ok("keychain set reports the keychain backend", put.backend === "keychain");
    ok("keychain get returns the exact value (quotes and spaces intact)", openStore(env).get("ZZZ_DRILL_API_KEY") === VALUE);
    putSecret("ZZZ_DRILL_API_KEY", "second", env);
    ok("a second set updates in place", openStore(env).get("ZZZ_DRILL_API_KEY") === "second");
    ok("values() reads it back as the env layer", resolveSecrets(env).ZZZ_DRILL_API_KEY === "second");
    ok("keychain remove empties the item", dropSecret("ZZZ_DRILL_API_KEY", env).removed && openStore(env).get("ZZZ_DRILL_API_KEY") === null);
  } finally {
    execSync(`/usr/bin/security delete-keychain ${JSON.stringify(kc)}`);
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} secrets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
