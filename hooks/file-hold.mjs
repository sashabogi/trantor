#!/usr/bin/env node
import { relative, resolve } from "node:path";
import { relayUrl, sessionContext, signedPost } from "./lib/api.mjs";

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
  } }));
}

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || "{}");
  const path = input.tool_name === "NotebookEdit" ? input.tool_input?.notebook_path : input.tool_input?.file_path;
  const ctx = sessionContext(input.cwd);
  if (!path || !ctx.project) process.stdout.write("{}");
  else {
    const absolute = resolve(ctx.projectDir, path);
    const rel = relative(ctx.projectDir, absolute);
    const file = !rel.startsWith("..") ? rel : absolute;
    // Register and check atomically: parallel PreToolUse hooks cannot race the first claim.
    const r = await signedPost(`${relayUrl(ctx.project)}/hold/check`,
      { project: ctx.project, file, session: ctx.session },
      { timeoutMs: 2500, session: ctx.session });
    if (!r.ok || !r.json?.ok) deny("Cannot check file holds: hub unavailable. Retry when the hub is reachable.");
    else if (r.json.hold) deny(r.json.hold.reason);
    else process.stdout.write("{}");
  }
} catch {
  deny("Cannot check file holds: request failed. Retry when the hub is reachable.");
}
