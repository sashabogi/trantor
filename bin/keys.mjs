#!/usr/bin/env node
// trantor keys — identity private keys in the macOS Keychain instead of plaintext files (#11370).
//   status [--json] · migrate [--dry-run] [--json]
// migrate copies each file-held key into the Keychain (service trantor-identity), proves a
// signature round-trip, and only then rewrites the file as a pubkey-only stub. Keys are never printed.
import { migrateKeysToKeychain, keyLocationReport, IDENTITY_SERVICE } from "../lib/identity.mjs";

const args = process.argv.slice(2);
const verb = args[0] || "status";
const JSON_MODE = args.includes("--json");
const C = { dim: "\x1b[2m", grn: "\x1b[32m", yel: "\x1b[33m", red: "\x1b[31m", off: "\x1b[0m" };
const usage = () => {
  console.error("usage: trantor keys status [--json] | migrate [--dry-run] [--json]");
  process.exit(1);
};
const tilde = (p) => String(p).replace(process.env.HOME || "", "~");
const shortPub = (p) => (p ? `${p.slice(0, 16)}…` : "(unreadable)");

function status() {
  const rows = keyLocationReport();
  if (JSON_MODE) { console.log(JSON.stringify({ service: IDENTITY_SERVICE, rows }, null, 2)); return; }
  if (!rows.length) { console.log(`${C.dim}no identities yet (~/.agent-bus/keys is empty)${C.off}`); return; }
  console.log(`identity keys (keychain service: ${IDENTITY_SERVICE}):`);
  for (const r of rows) {
    const mark = r.where === "keychain" ? `${C.grn}✓${C.off}` : r.fileKey ? `${C.yel}•${C.off}` : `${C.red}✗${C.off}`;
    console.log(`  ${mark} ${r.name.padEnd(28)} ${shortPub(r.pubkey).padEnd(19)} ${r.where}`);
  }
  const plaintext = rows.filter((r) => r.fileKey);
  if (plaintext.length) console.log(`\n${plaintext.length} key(s) still in plaintext files → trantor keys migrate`);
}

function migrate() {
  const dryRun = args.includes("--dry-run");
  const r = migrateKeysToKeychain({ dryRun });
  if (JSON_MODE) { console.log(JSON.stringify(r, null, 2)); return; }
  if (!r.usable) {
    console.log("no Keychain on this platform (or TRANTOR_NO_KEYCHAIN=1) — identity keys stay in files; nothing to do");
    return;
  }
  const did = dryRun ? "would move" : "moved";
  console.log(`${dryRun ? `${C.dim}dry run${C.off} · ` : ""}keychain service: ${r.service}`);
  for (const n of r.moved) console.log(`  ${C.grn}✓${C.off} ${did} ${n}${dryRun ? "" : " (file is now a pubkey-only stub)"}`);
  for (const n of r.already) console.log(`  ${C.dim}already in the keychain: ${n}${C.off}`);
  for (const f of r.failed) console.log(`  ${C.red}✗${C.off} ${f.name}: ${f.reason} — the file was left untouched`);
  if (!r.moved.length && !r.failed.length && !r.already.length) console.log(`  ${C.dim}nothing to move${C.off}`);
  if (r.failed.length) process.exit(1);
}

switch (verb) {
  case "status": status(); break;
  case "migrate": migrate(); break;
  default: usage();
}
