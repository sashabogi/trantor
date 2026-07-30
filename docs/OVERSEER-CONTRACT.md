# OVERSEER build contract — frozen for this crew run (2026-07-30)

Read FIRST: PRD §5.5/§6 (what the overseer is), TDD §10 (design), TDD §13 (the as-built
substrate you build on: file claims, presence with llm/model, orgPolicy storage).

**The doctrine:** detection is MECHANICAL (computed, certain, free); the LLM only NARRATES.
The overseer prevents collisions; it never reviews code. Warnings reach a session ONLY through
its own harness (hooks). Nothing here blocks work below level 3.

## Shared shapes (FROZEN — drift here is the failure mode)

```js
// orgPolicy (hub state, persisted via kv "orgPolicy")
{
  autonomy: { "<project>": 1|2|3|4, "*": 1 },   // 1 observe · 2 warn · 3 gate · 4 auto (4 unimplemented)
  links: [ { projects: ["a","b"], reason: "<=140 chars", declaredBy: "<identity>", ts: <ms> } ]
}

// collision (what detectCollisions returns; what overseer.warn carries in its payload)
{
  project: "<project>",                  // the project whose sessions should hear it
  kind: "same-project-sessions" | "file-conflict" | "linked-activity",
  sessions: ["<session>", ...],          // the parties
  files: ["<repo-relative>", ...] | [],  // file-conflict only
  detail: "<one mechanical sentence, cites sessions/files/projects — no speculation>"
}

// event on the unified log (dotted type -> FEED, never /history)
appendEvent("overseer.warn", project, "overseer", { kind, sessions, files, detail, narrated: false })
// narration worker later posts: POST /overseer/narrate { eventId, text } -> event gains narrated:true, narration:text

// GET /overseer/context?project=<p>   (hub computes; the SessionStart hook only injects)
{
  level: 1|2|3|4,
  links: [ { projects, reason } ],            // links touching <p>
  peers: [ { session, llm, model, status } ], // live sessions on <p> and on linked projects
  inflight: [ { file, session, agoSec } ],    // live claims on <p>
  warnings: [ collision, ... ]                // current collisions involving <p>
}
```

## Package boundaries (ONE owner per file — never touch another seat's files)

| owner | files (create/own) | spec |
|---|---|---|
| codex | `lib/overseer.mjs`, `test-overseer-lib.mjs` | Pure module, NO I/O, NO imports beyond node core. Export `detectCollisions({ peers, claims, links, autonomy, now }) -> collision[]` and `levelFor(project, autonomy) -> number` (project key, else "*", else 1). Inputs: peers = [{session, project, lastSeen, llm, model, status}] (live = lastSeen within 5m of now); claims = [{project, file, session, ts}]; links/autonomy per shapes above. Kinds: (1) same-project-sessions — ≥2 live sessions on one project → one collision per project listing them; (2) file-conflict — ≥2 live claims by different sessions on same (project,file) within 10m → one collision per file; (3) linked-activity — live sessions in ≥2 projects of one declared link → one collision per link. Deterministic ordering (sort by project, kind, first file/session). Unit tests: every kind, level fallback, empty inputs, dedup, ordering. Test runs with plain `node test-overseer-lib.mjs`, prints ✓/✗ lines, exits non-zero on failure (house style: read test-claims.mjs). |
| kimi | `hooks/overseer-warn.mjs`, `test-overseer-warn.mjs` | SessionStart hook, house style of hooks/file-claim.mjs (fail-open ALWAYS, 1500ms timeout, stdin JSON {cwd,...}). Resolve project via `sessionContext(input.cwd)` from hooks/lib/api.mjs; `getJSON(relayUrl(project) + "/overseer/context?project=...")`. If level>=2 AND (warnings.length or inflight.length or links.length): emit {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<paragraph>"}}. The paragraph: linked projects + why, who is live (llm·model), which files are in flight — plain language, cite sessions/files, <=900 chars. level<2 or nothing to say or hub down -> {}. Test: spawn a stub HTTP server serving a canned /overseer/context, run the hook with piped stdin exactly as test-claims.mjs runs file-claim.mjs; assert injection at level 2, silence at level 1, fail-open when server down. |
| deepseek | `bin/overseer-narrate.mjs` | Worker, house style of bin/summarize.mjs (read it first — config/hubs/sfetchJson/owner identity/scroogeBin/--dry/--quiet/--limit are the same pattern). Find recent overseer.warn events with narrated:false via GET /events?type=overseer.&limit=100 on each hub; batch ONE scrooge call (task=reason, difficulty=easy): for each event produce {"eventId":N,"text":"<=200 chars, cites the sessions/files/projects from detail, says what to do (coordinate over the bus / split files / declare a link)"}. POST /overseer/narrate {eventId, text} per event; check r.ok (never count a failed write). |
| openrouter | `desktop/src/features/home/Collisions.tsx` (NEW, self-contained) | React+TS. Export `Collisions({ client }: { client: HubClient })`: fetch `client.events({ type: "overseer.", limit: 50 })`, keep events with narrated or detail, newest first, cap 8; render with the app's primitives (READ desktop/src/styles.css + Home.tsx first): section title "Collisions", tr-sec-sub "Where two agents are about to step on each other.", rows = tr-card with tr-dot (fail color for file-conflict, warn otherwise), the narration (fallback detail) as text, project + kind as tr-chip. Empty state: tr-card-ghost "No collisions — the fleet is clear." DO NOT edit Home.tsx or any existing file — the orchestrator wires the import. Type-check must pass: cd desktop && npm run build. |
| glm | `test-overseer.mjs` | End-to-end hub tests, house style of test-claims.mjs (spawnHub pattern, RELAY_AUTH=off). Cover: GET /policy default {autonomy:{"*":1},links:[]}; POST /policy set autonomy + add link (persists across GET); overseer tick: register 2 live sessions on one project at level>=2 -> overseer.warn event with kind same-project-sessions appears in /events?type=overseer. within ~3s; two conflicting /claim posts -> file-conflict warn; level 1 -> events still logged (observe) BUT /overseer/context.warnings populated; level 3 + file-conflict -> a verify gate opens (GET /verify-gates shows it); POST /overseer/narrate marks event narrated. NOTE: the hub side lands in parallel — write tests to THIS contract, run with `node test-overseer.mjs`; if an endpoint 404s, the hub isn't wired yet: report progress and retest on the orchestrator's ping, don't guess alternate shapes. |
| orchestrator (DO NOT TOUCH) | `hub.mjs`, `hooks/hooks.json`, `bin/cli.mjs`, `bin/policy.mjs`, `desktop/src/features/home/Home.tsx`, `desktop/src/features/settings/Settings.tsx`, `package.json` | /policy endpoints, overseer tick (30s, on-event debounce), overseer.warn emission + dedup window (don't re-warn the same collision within 10m), level-3 gate opening, /overseer/context, /overseer/narrate, hook+CLI registration, app wiring, integration. |

## House rules (from the fleet's own lessons)
- Cards: `todo -> doing -> testing -> done`; `testing` = `npm test` green (repo root) or `cd desktop && npm run build` green for the app package. NEVER skip to done.
- Report DONE on the bus with: files on disk, test command, real exit code.
- hub.mjs greps as binary — use `grep -a`. Do not edit files you don't own — file claims are LIVE and will warn you; heed the warning.
- Fail-open is a contract for hooks: a hook that throws or hangs breaks the user's session.
