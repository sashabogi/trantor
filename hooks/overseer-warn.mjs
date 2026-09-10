#!/usr/bin/env node
// trantor SessionStart overseer-warn: detection is MECHANICAL in the hub (GET /overseer/context);
// this hook only NARRATES it at session start (docs/OVERSEER-CONTRACT.md). Informational below
// level 3, never blocking; fail-open (hub down, timeout, bad payload → {}).
// signedGet, not getJSON: an enforce hub 401s unsigned reads and the warning would never land.
import { relayUrl, sessionContext, signedGet } from "./lib/api.mjs";

const silent = () => { process.stdout.write("{}"); process.exit(0); };

function readStdin() {
  return new Promise(res => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 400);
  });
}

const ago = s => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

try {
  const raw = await readStdin();
  const input = JSON.parse(raw || "{}");
  const ctx = sessionContext(input.cwd);
  if (!ctx.project) silent();

  const r = await signedGet(`${relayUrl(ctx.project)}/overseer/context?project=${encodeURIComponent(ctx.project)}`, { session: ctx.session });
  // The response envelope is decoded by the field guards below: any truthy shape that is not the
  // expected object falls out at `level < 2` (or the nothing-to-say check) and lands in silent()
  // exactly like this guard used to — malformed payloads narrate nothing.
  if (!r.ok || !r.json) silent();
  const c = r.json;

  const level = Number(c.level || 1);
  const warnings = Array.isArray(c.warnings) ? c.warnings : [];
  const inflight = Array.isArray(c.inflight) ? c.inflight : [];
  const links = Array.isArray(c.links) ? c.links : [];
  const peers = Array.isArray(c.peers) ? c.peers : [];

  // level<2 is observe: the hub still logs, but sessions are not narrated at. And at any level,
  // nothing to say -> silence (an empty warning is noise that trains sessions to ignore real ones).
  if (level < 2 || (!warnings.length && !inflight.length && !links.length)) silent();

  const parts = [];
  if (links.length) {
    parts.push("Linked projects (declared codependence): " +
      links.map(l => `${(l.projects || []).join(" + ")} — ${l.reason || "linked"}`).join("; ") + ".");
  }
  if (peers.length) {
    parts.push("Live sessions on this/linked projects: " +
      peers.map(p => `${p.session}${p.llm ? ` (${[p.llm, p.model].filter(Boolean).join("·")})` : ""}${p.status ? `, ${p.status}` : ""}`).join(", ") + ".");
  }
  if (inflight.length) {
    parts.push("Files in flight right now: " +
      inflight.map(f => `${f.file} — ${f.session} (${ago(Number(f.agoSec) || 0)} ago)`).join(", ") + ".");
  }
  if (warnings.length) {
    parts.push("Overseer warnings: " +
      warnings.map(w => w.detail || w.kind).filter(Boolean).join("; ") + ".");
  }
  parts.push("Before editing a file another session has in flight, coordinate over the bus (relay_send) or split the work.");

  let text = parts.join(" ");
  if (text.length > 900) text = text.slice(0, 897) + "…";

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `⚠️ trantor overseer: ${text}`,
    },
  }));
  process.exit(0);
} catch {
  silent();
}
