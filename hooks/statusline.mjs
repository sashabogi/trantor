#!/usr/bin/env node
// USAGE v2 — the Claude statusline sidechannel (docs/RESEARCH-orca-usage.md §1.1).
// Claude Code >=2.1.80 pipes a JSON blob (with `rate_limits`) into the statusLine command on
// every turn, piggybacked on the Messages API response — live usage that costs zero API budget.
// This forwarder reads that stdin, POSTs the windows to the hub's /usage/claude (signed), and
// prints NOTHING: it is designed to be tee'd ahead of the operator's real statusline command,
// never to be one. Every failure is swallowed — a usage forwarder must never break a statusline.
//
// Floor: one POST per session per 15s (stamp file) — the statusline ticks ~3x/sec while
// streaming, and the hub dedupes same-value posts inside 30s anyway.
import { readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FLOOR_MS = 15_000;

async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const j = JSON.parse(raw);
  const rl = j.rate_limits;
  // SAFETY: rate_limits is the Claude statusline envelope decoded by JSON.parse above; the check
  // separates "tick carries a rate_limits envelope" (any object, even field-less — it refreshes
  // the stamp below) from "no envelope" (primitives/null — a free exit).
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (!rl || typeof rl !== "object") return;               // most ticks carry none — free exit
  const sid = String(j.session_id || j.sessionId || "nosession").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const dir = join(homedir(), ".agent-bus");
  const stamp = join(dir, `usage-claude-${sid}.stamp`);
  try { if (Date.now() - statSync(stamp).mtimeMs < FLOOR_MS) return; } catch {}
  try { mkdirSync(dir, { recursive: true }); writeFileSync(stamp, ""); } catch {}

  const payload = {
    configDir: process.env.CLAUDE_CONFIG_DIR || null,
    fiveHour: rl.five_hour ?? rl.fiveHour ?? null,
    sevenDay: rl.seven_day ?? rl.sevenDay ?? null,
    // The fable/model-scoped window normally arrives via the OAuth poller, but accept the
    // statusline-shaped variants too — schema drift degrades instead of going dark.
    fable: rl.fable_weekly ?? rl.fable ?? null,
  };
  if (!payload.fiveHour && !payload.sevenDay && !payload.fable) return;
  // PRIMARY: the local live cache — lib/balances.mjs merges it and skips the OAuth poll while
  // it is fresh (Orca's isLiveClaudeUsageFresh, docs/RESEARCH-orca-usage.md §2). This is the
  // path the app's footer actually reads (it shells the local CLI, not the hub).
  try { writeFileSync(join(dir, "usage-claude-live.json"), JSON.stringify({ ts: Date.now(), ...payload })); } catch {}
  // SECONDARY, best-effort: the hub copy, for dashboard surfaces that read hub state.
  const { signedPost } = await import("./lib/api.mjs");
  await signedPost("/usage/claude", payload, { timeoutMs: 2500 });
}

main().catch(() => {}).finally(() => process.exit(0));
