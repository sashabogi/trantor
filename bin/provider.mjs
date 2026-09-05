#!/usr/bin/env node
// trantor provider — bring ANY model to the crew (BYOM). opencode is a universal adapter, so a
// provider you configure there (or declare here) becomes a crew seat with no code change.
//
//   trantor provider                 # seats (built-in + discovered) + the provider status board
//   trantor provider status [--json] # the registry: state + reason per provider (#6390)
//   trantor provider login <name>    # run the CLI's own login command (the pane's "login" action)
//   trantor provider verify <name> --key sk-… [--json]   # probe a CANDIDATE key, write nothing
//   trantor provider add <name> [--key sk-…] [--plan api|coding-plan|max] [--label <bus-name>]
//                       [--base-url <url> [--models m1,m2]]   # wire a CUSTOM OpenAI-compatible endpoint
//   trantor provider remove <name> [--credentials]   # drop it from your profile (--credentials: also the key)
//
// `add` writes <NAME>_API_KEY to ~/.agent-bus/.env (if --key given), declares the plan in your
// quota profile, verifies opencode can see the provider's models, and prints the seat spec. For a
// provider opencode already knows (openrouter, groq, …) the key is enough; for a CUSTOM endpoint,
// pass --base-url and it writes the opencode.json provider block for you. The Advisor then routes
// to it automatically; run `scrooge-capabilities` so it routes well by difficulty.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildRoster, loadWorld } from "./advise.mjs";
import { providerStatus, providerVerify, PROVIDERS } from "../lib/providers.mjs";

const H = homedir();
const ENV = join(H, ".agent-bus", ".env");
const read = (p, fb) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; } };
const has = (c) => { try { execSync(`command -v ${c}`, { stdio: "ignore", shell: "/bin/sh" }); return true; } catch { return false; } };
const C = { dim: "\x1b[2m", grn: "\x1b[32m", red: "\x1b[31m", yel: "\x1b[33m", gold: "\x1b[38;5;208m", off: "\x1b[0m" };
const envKeyName = (p) => `${String(p).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

const OC_CONFIG = join(H, ".config", "opencode", "opencode.json");
// Wire a CUSTOM OpenAI-compatible provider into opencode.json (matching opencode's schema +
// the existing providers' `options.apiKey` style). Merges, never clobbers other providers.
// `configPath` is injectable so it can be unit-tested against a temp file.
export function wireOpencodeProvider(name, baseUrl, models, configPath = OC_CONFIG) {
  const cfg = existsSync(configPath) ? read(configPath, {}) : {};
  cfg.$schema ||= "https://opencode.ai/config.json";
  cfg.provider ||= {};
  const block = {
    npm: "@ai-sdk/openai-compatible",
    name: name.charAt(0).toUpperCase() + name.slice(1),
    options: { baseURL: baseUrl, apiKey: `{env:${envKeyName(name)}}` },
  };
  if (models && models.length) block.models = Object.fromEntries(models.map(m => [m, {}]));
  cfg.provider[name] = { ...cfg.provider[name], ...block };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  return configPath;
}

function opencodeModelCount(providerOc) {
  if (!has("opencode")) return null;
  try { return execSync(`opencode models ${providerOc} 2>/dev/null`, { encoding: "utf8" }).split("\n").filter(Boolean).length; }
  catch { return 0; }
}

function listSeats() {
  const world = loadWorld();
  const { roster, agents, profile } = world;
  console.log("CREW SEATS — built-in + brought (BYOM). ● = available now\n");
  for (const [label, s] of Object.entries(roster)) {
    const live = agents.includes(label);
    const tier = profile?.providers?.[s.provider]?.tier || (s.cli === "opencode" ? "—" : "");
    const kind = s.discovered ? "brought " : "built-in";
    const models = s.cli === "opencode" ? opencodeModelCount(s.providerOc) : null;
    const mtxt = models == null ? "" : `${models} models`;
    const dot = live ? `${C.grn}●${C.off}` : `${C.dim}○${C.off}`;
    console.log(`  ${dot} ${label.padEnd(14)} ${C.dim}${kind}${C.off}  launch: ${s.launch.padEnd(26)} ${tier ? `tier=${tier}` : ""} ${C.dim}${mtxt}${C.off}`);
  }
  console.log(`\n${C.dim}add one:${C.off} trantor provider add <name> --key sk-… --plan api`);
  console.log(`${C.dim}browse models:${C.off} trantor models [<provider>]`);
}

// The status board (#6390) — the human face of lib/providers.mjs. Same rows the --json contract
// and the desktop pane render; every row carries a state AND a reason, so nothing can show blank.
const STATE_MARK = {
  connected:      (c) => `${C.grn}●${c.off}`,
  over_quota:     (c) => `${C.red}✗${c.off}`,
  expired:        (c) => `${C.red}✗${c.off}`,
  not_installed:  (c) => `${C.dim}○${c.off}`,
  not_logged_in:  (c) => `${C.dim}○${c.off}`,
  unknown:        (c) => `${C.yel}?${c.off}`,
};

function printStatusRows(rows) {
  console.log("PROVIDERS — state + reason per provider (detail: trantor provider status --json)\n");
  for (const r of rows) {
    const mark = (STATE_MARK[r.state] || STATE_MARK.unknown)(C);
    console.log(`  ${mark} ${r.provider.padEnd(12)} ${r.state.padEnd(14)} ${C.dim}${r.reason}${C.off}`);
  }
}

async function statusCmd(opts) {
  const rows = await providerStatus();
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  printStatusRows(rows);
  const fixable = rows.filter((r) => r.actions.includes("login") || r.actions.includes("paste-key"));
  if (fixable.length) {
    console.log(`\n${C.dim}fix one:${C.off} ${fixable.map((r) => r.provider).join(", ")}`);
    console.log(`${C.dim}probe a key before saving it:${C.off} trantor provider verify <name> --key sk-…`);
  }
}

// The pre-save verify seam (#6391's ask): probe a CANDIDATE key through the SAME registry probe
// the status board uses, and write nothing anywhere — .env, profile.json and opencode.json are
// only touched later, by `provider add`, once the key is known live.
async function verifyCmd(name, opts) {
  if (!name || name.startsWith("--") || name === "help" || !opts.key) {
    console.error("usage: trantor provider verify <name> --key sk-… [--json]");
    process.exit(1);
  }
  let r;
  try { r = await providerVerify(name, opts.key); }
  catch (e) { console.error(String(e?.message || e)); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
  const mark = (STATE_MARK[r.state] || STATE_MARK.unknown)(C);
  console.log(`  ${mark} ${r.provider.padEnd(12)} ${r.state.padEnd(14)} ${C.dim}${r.reason}${C.off}`);
  console.log(r.state === "connected"
    ? `\n${C.grn}Key is live.${C.off} Nothing was written — commit it: trantor provider add ${r.provider} --key …`
    : `\n${C.dim}Nothing was written.${C.off} Fix the state above, then: trantor provider add ${r.provider} --key …`);
}

function addProvider(name, opts) {
  // A flag left in the name position (`provider add --help`) is a usage question, not a provider
  // name (#5998): the old path minted a '--help' provider into profile.json and a __HELP_API_KEY
  // line into .env, then announced "Seat ready." The literal 'help' is guarded too — it is never
  // a provider name. Both die HERE, before .env, profile.json or opencode.json are touched.
  if (!name || name.startsWith("--") || name === "help") {
    console.error("usage: trantor provider add <name> [--key sk-…] [--plan api] [--label <bus-name>] [--base-url <url> [--models m1,m2]]");
    process.exit(1);
  }
  const provider = name.toLowerCase();
  const label = (opts.label || provider).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const plan = (opts.plan || "api").toLowerCase();

  // 1) key → ~/.agent-bus/.env (the runner sources it; opencode reads <NAME>_API_KEY for known providers)
  if (opts.key) {
    mkdirSync(dirname(ENV), { recursive: true });
    const k = envKeyName(provider);
    let cur = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
    if (new RegExp(`^${k}=`, "m").test(cur)) {
      cur = cur.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${opts.key}`);
      writeFileSync(ENV, cur);
    } else {
      appendFileSync(ENV, `${cur && !cur.endsWith("\n") ? "\n" : ""}# ${provider} — brought via 'trantor provider add'\n${k}=${opts.key}\n`);
    }
    try { chmodSync(ENV, 0o600); } catch {}
    console.log(`${C.grn}✓${C.off} wrote ${envKeyName(provider)} → ~/.agent-bus/.env (chmod 600)`);
  }

  // 2) declare the plan in the quota profile (drives the Advisor's tier/cost reasoning)
  try {
    execSync(`node ${join(dirname(new URL(import.meta.url).pathname), "profile.mjs")} set ${provider}=${plan}`, { stdio: "ignore" });
    console.log(`${C.grn}✓${C.off} profile: ${provider}=${plan}`);
  } catch (e) { console.log(`${C.yel}⚠${C.off} could not set profile (run: trantor profile set ${provider}=${plan})`); }

  // 3) custom endpoint → write the opencode.json provider block (known providers skip this)
  if (opts.baseUrl) {
    const models = (opts.models || "").split(",").map(s => s.trim()).filter(Boolean);
    const where = wireOpencodeProvider(provider, opts.baseUrl, models);
    console.log(`${C.grn}✓${C.off} wired custom provider '${provider}' → ${where.replace(H, "~")} (baseURL ${opts.baseUrl}${models.length ? `, ${models.length} models` : ""})`);
  }

  // 4) verify opencode can see the provider's models
  const n = opencodeModelCount(provider);
  if (n == null) console.log(`${C.yel}⚠${C.off} opencode not on PATH — install it to run this seat (it's the universal adapter)`);
  else if (n === 0) console.log(`${C.yel}⚠${C.off} opencode lists 0 models for '${provider}'.${opts.baseUrl ? " Check the baseURL/key, or pass --models m1,m2 to declare them." : " If it's a known provider, the key above is enough; for a CUSTOM endpoint re-run with --base-url <url> [--models m1,m2]."} Re-check: trantor models ${provider}`);
  else console.log(`${C.grn}✓${C.off} opencode sees ${n} models for '${provider}'`);

  // 5) score it for difficulty-aware routing + show the seat
  console.log(`\n${C.gold}Seat ready.${C.off} Launch it:`);
  console.log(`  trantor up ${label === provider ? label : `${label}:${provider}`}            ${C.dim}# live-selects the best model for the work${C.off}`);
  console.log(`  trantor up ${label}:${provider}/<model>     ${C.dim}# pin a specific model${C.off}`);
  console.log(`${C.dim}For difficulty-aware routing across its catalog, score it once (weekly):${C.off} scrooge-capabilities`);
}

function removeProvider(name, opts = {}) {
  // Same guard as add (#5998): a flag-like name is a usage question, not a provider.
  if (!name || name.startsWith("--") || name === "help") {
    console.error("usage: trantor provider remove <name> [--credentials]");
    process.exit(1);
  }
  const provider = PROVIDERS.find((candidate) => candidate.provider === name.toLowerCase());
  if (opts.credentials && provider?.logoutRun) {
    const logout = spawnSync(provider.logoutRun[0], provider.logoutRun.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (logout.error || (logout.status !== 0 && logout.status !== null)) {
      const detail = String(logout.stderr || logout.error?.message || "").trim();
      console.error(`${provider.logoutRun.join(" ")} exited ${logout.status ?? "?"}${detail ? ` — ${detail}` : ""}`);
      process.exit(1);
    }
    console.log(`${C.grn}✓${C.off} signed out of the ${provider.label} system login`);
  }
  const FILE = join(H, ".agent-bus", "profile.json");
  const prof = read(FILE, { providers: {} });
  if (prof.providers && prof.providers[name.toLowerCase()]) {
    delete prof.providers[name.toLowerCase()];
    writeFileSync(FILE, JSON.stringify(prof, null, 2) + "\n");
    console.log(`${C.grn}✓${C.off} removed '${name}' from your profile (the ${envKeyName(name)} key is left in place; delete it from ~/.agent-bus/.env if you want it gone)`);
  } else {
    console.log(`'${name}' is not in your profile.`);
  }
  // The Accounts pane's "remove" affordance (#6391) passes --credentials: drop the key line too,
  // so removing a provider from the UI doesn't leave a live secret in the crew's .env.
  if (opts.credentials) {
    const k = envKeyName(name);
    if (existsSync(ENV)) {
      const cur = readFileSync(ENV, "utf8");
      const next = cur.split("\n").filter((l) => !l.startsWith(`${k}=`)).join("\n");
      if (next !== cur) {
        writeFileSync(ENV, next);
        try { chmodSync(ENV, 0o600); } catch {}
        console.log(`${C.grn}✓${C.off} removed ${k} from ~/.agent-bus/.env`);
      } else {
        console.log(`${C.dim}${k} was not in ~/.agent-bus/.env${C.off}`);
      }
    }
  }
}

// `provider login <name>` — the pane's "login" action (#6391): run the CLI's OWN login command
// in the foreground (stdio inherited — OAuth flows print QR codes/URLs and need real stdin),
// then point at the status board for the live re-check. api-key providers have no login to run;
// the hint is the paste-key path.
function loginProvider(name) {
  if (!name || name.startsWith("--") || name === "help") {
    console.error("usage: trantor provider login <name>");
    process.exit(1);
  }
  const p = PROVIDERS.find((x) => x.provider === name.toLowerCase());
  if (!p) { console.error(`unknown provider '${name}' — one of: ${PROVIDERS.map((x) => x.provider).join(", ")}`); process.exit(1); }
  if (!p.loginRun) {
    console.log(`${p.label} authenticates by API key — no login flow to run.`);
    console.log(`${C.dim}probe a candidate key first, then commit it:${C.off}`);
    console.log(`  trantor provider verify ${p.provider} --key sk-…`);
    console.log(`  trantor provider add ${p.provider} --key sk-…`);
    return;
  }
  console.log(`${C.dim}running:${C.off} ${p.loginRun.join(" ")}  ${C.dim}(the CLI's own login — sign in there)${C.off}`);
  const r = spawnSync(p.loginRun[0], p.loginRun.slice(1), { stdio: "inherit" });
  if (r.error || (r.status !== 0 && r.status !== null)) {
    console.error(`\n${p.loginRun[0]} exited ${r.status ?? "?"} — install it first, then re-run: trantor provider login ${p.provider}`);
    process.exit(1);
  }
  console.log(`\n${C.dim}re-check it live:${C.off} trantor provider status`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , sub, ...rest] = process.argv;
  const opts = {}; const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--key") opts.key = rest[++i];
    else if (rest[i] === "--plan") opts.plan = rest[++i];
    else if (rest[i] === "--label") opts.label = rest[++i];
    else if (rest[i] === "--base-url" || rest[i] === "--baseurl") opts.baseUrl = rest[++i];
    else if (rest[i] === "--models") opts.models = rest[++i];
    else if (rest[i] === "--json") opts.json = true;
    else if (rest[i] === "--credentials") opts.credentials = true;
    else pos.push(rest[i]);
  }
  // The default list leads with the seats roster and closes with the provider status board —
  // one command answers both "what can I launch" and "what is actually alive" (#6390).
  const defaultList = async () => {
    listSeats();
    console.log("");
    printStatusRows(await providerStatus());
  };
  if (!sub || sub === "list") await defaultList();
  else if (sub === "status") await statusCmd(opts);
  else if (sub === "verify") await verifyCmd(pos[0], opts);
  else if (sub === "login") loginProvider(pos[0]);
  else if (sub === "add") addProvider(pos[0], opts);
  else if (sub === "remove" || sub === "rm") removeProvider(pos[0], opts);
  else { console.error(`unknown subcommand '${sub}' — use: list | status | verify | login | add | remove`); process.exit(1); }
}
