#!/usr/bin/env node
import { gitCheckoutRoot } from "./lib/git-checkout.mjs";
import { relative, resolve } from "node:path";
import { relayUrl, sessionContext, signedPost } from "./lib/api.mjs";
import { failOpenAfter, readStdinWithin } from "./lib/fail-open.mjs";
import { readOverseerLevel, writeOverseerLevel } from "./lib/overseer-level-cache.mjs";

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
  } }));
}

function unavailable() {
  process.stderr.write("trantor: file hold could not be checked; allowing this edit.\n");
  process.stdout.write("{}");
}

// 2.1.299: a gating hook that cannot answer in time is refused, which would block the edit. The hub
// call below is capped at 2.5s; this backstop answers "no decision" if anything else hangs.
failOpenAfter(Number(process.env.RELAY_HOLD_WATCHDOG_MS || 5000));

try {
  const raw = await readStdinWithin(1000);
  const input = JSON.parse(raw || "{}");
  const path = input.tool_name === "NotebookEdit" ? input.tool_input?.notebook_path : input.tool_input?.file_path;
  const ctx = sessionContext(input.cwd);
  if (!path || !ctx.project) process.stdout.write("{}");
  else {
    const cache = { project: ctx.project, hub: relayUrl(ctx.project) };
    const level = readOverseerLevel(cache);
    if (level !== null && level < 3) {
      process.stdout.write("{}");
      process.exit(0);
    }
    const gitRoot = gitCheckoutRoot(ctx.projectDir);
    const absolute = resolve(ctx.projectDir, path);
    const rel = relative(gitRoot || ctx.projectDir, absolute);
    const file = !rel.startsWith("..") ? rel : absolute;
    // Register and check atomically: parallel PreToolUse hooks cannot race the first claim.
    const r = await signedPost(`${cache.hub}/hold/check`,
      { project: ctx.project, file, session: ctx.session, gitRoot },
      { timeoutMs: 2500, session: ctx.session });
    if (!r.ok || !r.json?.ok) unavailable();
    else {
      writeOverseerLevel(cache, r.json.level);
      if (r.json.hold) deny(r.json.hold.reason);
      else process.stdout.write("{}");
    }
  }
} catch {
  unavailable();
}
// The hook has answered. A host that left stdin open must not keep the process (and a second watchdog answer) alive.
process.exit(0);
