#!/usr/bin/env node
// trantor secrets — the crew's provider keys in the OS keychain instead of ~/.agent-bus/.env (#6393).
//   list [--json] · set <NAME> (value on stdin: printf '%s' "$KEY" | trantor secrets set NAME)
//   remove <NAME> · migrate [--dry-run] [--json] (each live .env key moves; its line becomes a stub)
import { readFileSync } from "node:fs";
import { openStore, putSecret, dropSecret, migrateSecrets, envFileSecrets, manifestPath } from "../lib/secrets.mjs";

const args = process.argv.slice(2);
const verb = args[0] || "list";
const JSON_MODE = args.includes("--json");
const C = { dim: "\x1b[2m", grn: "\x1b[32m", yel: "\x1b[33m", off: "\x1b[0m" };
const usage = () => {
  console.error("usage: trantor secrets list [--json] | set <NAME>  (value on stdin) | remove <NAME> | migrate [--dry-run] [--json]");
  process.exit(1);
};
const nameArg = () => {
  const name = args[1];
  if (!name || name.startsWith("--") || name === "help") usage();
  return name;
};
const tilde = (p) => p.replace(process.env.HOME || "", "~");

function list() {
  const store = openStore();
  const inStore = new Set(store.names());
  const file = envFileSecrets();
  const rows = [...new Set([...inStore, ...file.live, ...file.stubbed])].sort().map((name) => ({
    name,
    keychain: inStore.has(name),
    envLive: file.live.includes(name),
    where: inStore.has(name) && file.live.includes(name) ? "keychain + .env (live line)" : inStore.has(name) ? store.backend : file.live.includes(name) ? ".env" : "stub only",
  }));
  if (JSON_MODE) { console.log(JSON.stringify({ backend: store.backend, manifest: manifestPath(), rows }, null, 2)); return; }
  console.log(`store: ${store.backend}${store.backend === "none" ? " (nothing migrated yet)" : ""}  ${C.dim}${tilde(manifestPath())}${C.off}`);
  if (!rows.length) { console.log(`${C.dim}no provider keys anywhere (trantor provider add <name> --key …)${C.off}`); return; }
  for (const r of rows) console.log(`  ${r.envLive ? `${C.yel}•${C.off}` : `${C.grn}✓${C.off}`} ${r.name.padEnd(28)} ${r.where}`);
  if (file.live.length) console.log(`\n${file.live.length} key(s) still live in ${tilde(file.file)} → trantor secrets migrate`);
}

function set() {
  const name = nameArg();
  if (process.stdin.isTTY) {
    console.error(`the value is read from stdin, so it never lands in your shell history:  printf '%s' "$KEY" | trantor secrets set ${name}`);
    process.exit(1);
  }
  const value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (!value) usage();
  try {
    const r = putSecret(name, value);
    console.log(`${C.grn}✓${C.off} ${name} → ${r.backend}${r.stubbed ? ` (the .env line is now a stub)` : ""}`);
  } catch (e) { console.error(String(e?.message || e)); process.exit(1); }
}

function remove() {
  const name = nameArg();
  try {
    const r = dropSecret(name);
    console.log(r.removed ? `${C.grn}✓${C.off} removed ${name} from the ${r.backend} store` : `${C.dim}${name} was not in the store${C.off}`);
  } catch (e) { console.error(String(e?.message || e)); process.exit(1); }
}

function migrate() {
  const dryRun = args.includes("--dry-run");
  let r;
  try { r = migrateSecrets(process.env, { dryRun }); }
  catch (e) { console.error(String(e?.message || e)); process.exit(1); }
  if (JSON_MODE) { console.log(JSON.stringify(r, null, 2)); return; }
  const verb = dryRun ? "would move" : "moved";
  console.log(`${dryRun ? `${C.dim}dry run${C.off} · ` : ""}store: ${r.backend} · ${tilde(r.file)}`);
  for (const n of r.moved) console.log(`  ${C.grn}✓${C.off} ${verb} ${n}`);
  for (const n of r.cleared) console.log(`  ${C.yel}•${C.off} ${dryRun ? "would stub" : "stubbed"} empty ${n}`);
  if (r.stubbed.length) console.log(`  ${C.dim}already moved: ${r.stubbed.join(", ")}${C.off}`);
  if (r.kept.length) console.log(`  ${C.dim}kept in .env (not secrets): ${r.kept.join(", ")}${C.off}`);
  if (!r.moved.length && !r.cleared.length) console.log(`  ${C.dim}nothing to move${C.off}`);
}

switch (verb) {
  case "list": list(); break;
  case "set": set(); break;
  case "remove": case "rm": remove(); break;
  case "migrate": migrate(); break;
  default: usage();
}
