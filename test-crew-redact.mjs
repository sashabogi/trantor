// Regression for #5869: seat err logs (~/.agent-bus/err-<agent>-<project>.txt) carried LIVE
// provider keys whenever a CLI echoed its environment or dumped a config, and any seat on the
// machine could read them. Three layers now scrub, and this test feeds key-shaped output through
// each: (1) redactKeys() the pure scrubber, (2) the runner's tee replacement (lib/redact.mjs
// --tee/--tee2 — raw to the live window, redacted to the err file), (3) the exact runTurn bash
// topology plus the at-rest scrub pass before the file is read back. Ordinary lines must stay
// byte-identical; the auth/empty-output classifier phrases must survive redaction.
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactKeys } from "./lib/redact.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const SCRUB = join(ROOT, "lib", "redact.mjs");
let fail = 0; const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };

// Fabricated but shape-true key material — every rule class the runner must catch.
const KEYS = {
  sk: "sk-live-9f8e7d6c5b4a3210fedcba9876543210",
  sksp: "sk-sp-q7w8e9r0t1y2u3i4o5p6a7s8d9f0g1h2",
  skws: "sk-ws-zz9988yy77xx66ww55vv44uu33tt22ss",
  aiza: "AIzaSyD1234567890abcdefghijklmnopqrstuv",
  xai: "xai-0123456789abcdef0123456789abcdef",
  ghp: "ghp_AbCdEf0123456789AbCdEf0123456789ab",
  envKey: "DEEPSEEK_API_KEY=0123456789abcdef0123456789abcdef",
  envToken: "SCROOGE_TOKEN=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NQ==",
  bearer: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQ",
};
const PLAIN = [
  "turn starting (fresh session)",
  "error: 401 Unauthorized — check credentials",
  "exit 0 but turn output shows an auth failure",
  "the risky-board trick and sk-learn stay prose",
];

const blob = [
  ...PLAIN,
  `OPENAI_API_KEY=${KEYS.sk}`,
  `portal: ${KEYS.sksp}`,
  `workspace: ${KEYS.skws}`,
  `google: ${KEYS.aiza}`,
  `xai: ${KEYS.xai}`,
  `github: ${KEYS.ghp}`,
  KEYS.envKey,
  KEYS.envToken,
  KEYS.bearer,
].join("\n") + "\n";

const keyValues = Object.values(KEYS);
const flat = (s) => s.split("\n");

// --- 1) the pure scrubber ---
{
  const out = redactKeys(blob);
  for (const k of keyValues) ok(!out.includes(k), `redactKeys: ${k.slice(0, 14)}… gone`);
  ok(out.includes("DEEPSEEK_API_KEY=<redacted:DEEPSEEK_API_KEY>"), "redactKeys: KEY= keeps the variable name");
  ok(out.includes("SCROOGE_TOKEN=<redacted:SCROOGE_TOKEN>"), "redactKeys: TOKEN= keeps the variable name");
  ok(out.includes("OPENAI_API_KEY=<redacted:OPENAI_API_KEY>"), "redactKeys: KEY= wins over the bare sk- rule");
  ok(out.includes("Authorization: Bearer <redacted:BEARER>"), "redactKeys: Bearer token replaced");
  ok((out.match(/<redacted:SK>/g) ?? []).length === 2, "redactKeys: the two bare sk- shapes → <redacted:SK>");
  // ordinary lines byte-identical
  const outLines = new Set(flat(out));
  for (const l of PLAIN) ok(outLines.has(l), `redactKeys: ordinary line untouched — "${l.slice(0, 30)}…"`);
  // classifier phrases survive (auth + empty-output checks read redacted text)
  ok(redactKeys("Invalid API key provided: sk-abc123456789012345").includes("Invalid API key"),
    "redactKeys: auth classifier phrase survives");
  // idempotent: scrubbing twice equals scrubbing once
  ok(redactKeys(out) === out, "redactKeys: idempotent");
  // near-misses stay prose
  ok(redactKeys(PLAIN[3]) === PLAIN[3], "redactKeys: risky-/sk-learn near-misses untouched");
}

// --- 2) the tee replacement: raw passthrough, redacted at rest ---
{
  const dir = mkdtempSync(join(tmpdir(), "trantor-redact-"));
  const F = join(dir, "err-glm-test.txt");
  const r = spawnSync(process.execPath, [SCRUB, "--tee", F], { input: blob, encoding: "utf8" });
  ok(r.status === 0, `--tee: exit 0 (got ${r.status})`);
  ok(r.stdout === blob, "--tee: live window sees the raw stream verbatim");
  const file = readFileSync(F, "utf8");
  for (const k of keyValues) ok(!file.includes(k), `--tee: ${k.slice(0, 14)}… not in the written file`);
  for (const l of PLAIN) ok(flat(file).includes(l), `--tee: ordinary line intact — "${l.slice(0, 30)}…"`);
}

{
  const dir = mkdtempSync(join(tmpdir(), "trantor-redact-"));
  const F = join(dir, "err-glm-test2.txt");
  const r = spawnSync(process.execPath, [SCRUB, "--tee2", F], { input: blob, encoding: "utf8" });
  ok(r.status === 0, `--tee2: exit 0 (got ${r.status})`);
  ok(r.stderr === blob, "--tee2: stderr passthrough verbatim (the live window)");
  const file = readFileSync(F, "utf8");
  for (const k of keyValues) ok(!file.includes(k), `--tee2: ${k.slice(0, 14)}… not in the written file`);
}

// --- 3) the runner's exact topology: pipeline hop + process-substitution hop + at-rest scrub ---
// Mirrors runTurn's spawnSync line: `set -o pipefail; { CMD | scrub --tee F ; } 2> >(scrub --tee2 F)`
// followed by the synchronous `writeFileSync(F, redactKeys(readFileSync(F)))` before the read-back.
{
  const dir = mkdtempSync(join(tmpdir(), "trantor-redact-"));
  const F = join(dir, "err-glm-topo.txt");
  const inPath = join(dir, "stderr-dump.txt");
  writeFileSync(inPath, blob);
  const script = `set -o pipefail; { cat ${inPath} | node ${SCRUB} --tee ${F} ; } 2> >(node ${SCRUB} --tee2 ${F})`;
  const r = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", timeout: 30_000 });
  ok(r.status === 0, `topology: bash exit 0 (got ${r.status})`);
  // the at-rest scrub the runner runs before reading the file back
  writeFileSync(F, redactKeys(readFileSync(F, "utf8")));
  const file = readFileSync(F, "utf8");
  for (const k of keyValues) ok(!file.includes(k), `topology: ${k.slice(0, 14)}… never survives in the err file`);
  for (const l of PLAIN) ok(flat(file).includes(l), `topology: ordinary line intact — "${l.slice(0, 30)}…"`);
  ok(flat(file).filter(l => l.trim()).length >= PLAIN.length, "topology: both streams landed (no lost lines)");
}

// --- 4) chunk boundaries must not hide a key: a large stream with keys spread through it ---
{
  const dir = mkdtempSync(join(tmpdir(), "trantor-redact-"));
  const F = join(dir, "err-glm-big.txt");
  const parts = [];
  for (let i = 0; i < 2000; i++) {
    parts.push(`filler line ${i} — ordinary diagnostic chatter, no secrets here`);
    if (i % 100 === 50) parts.push(`echo KEY_${i}=${KEYS.sk}`);
  }
  const big = parts.join("\n") + "\n";
  const r = spawnSync(process.execPath, [SCRUB, "--tee", F], { input: big, encoding: "utf8" });
  ok(r.status === 0, "large stream: exit 0");
  ok(r.stdout === big, "large stream: passthrough byte-identical");
  const file = readFileSync(F, "utf8");
  ok(!file.includes(KEYS.sk), "large stream: no key survives across chunk boundaries");
  ok((file.match(/<redacted:SK>/g) ?? []).length === 20, "large stream: all 20 embedded keys redacted");
  ok(file.includes("filler line 1999 — ordinary diagnostic chatter, no secrets here"), "large stream: tail intact");
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
