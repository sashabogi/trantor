# INTERSESSION-OPS CONTRACT — frozen spec for crew cards #4214–4217

Doctrine (settled with Sasha 2026-08-07): sessions ADOPT live crews · every boot inventories
leftover resources and auto-cleans the provably dead · the duty agent patrols machine-wide.
**Provably dead = no live process AND no bus heartbeat AND no owning session. One signal is not
proof. NOTHING in this build ever kills a live process automatically — detection reports it,
a human or the owning session decides.**

File ownership (no seat touches another's files; orchestrator owns cli.mjs + integration):

## #4214 kimi — `hooks/lib/resources.mjs` + `test-resources.mjs`
Pure DETECTION library, ESM, Node ≥18, no deps beyond node builtins. Every export is
fail-silent (returns [] / "" on any error, never throws) and every subprocess has a ≤2s timeout.

```js
export function listCrewRows()          // → [{project,kind,agent,handle}] parsed from
                                        //   ~/.agent-bus/crew-windows.txt (respect RELAY_DATA_DIR).
                                        //   kinds: win|attach|tmux|cmux|cmuxws. Legacy 2-field rows
                                        //   ("AGENT\tWID") → {project:"",kind:"win",...}.
export function liveRunners(project)    // → [{pid,agent,dir}] by parsing `ps` output for
                                        //   "crew-runner.mjs <agent> <dir>". project=null → all;
                                        //   project given → only rows whose dir resolves to it
                                        //   (git-root basename walk, same as lib/project.mjs).
                                        //   ANCHORED matching — …/proj must never match …/proj2.
export function cmuxWorkspaces()        // → [{id,title}] via `cmux workspace list --json`
                                        //   (CMUX_QUIET=1, socket may be off → []).
export function devServers(dir)         // → [{pid,cmd}] dev-ish processes (next dev|vite|npm run
                                        //   dev|tail -f) whose cwd is under dir (lsof -a -d cwd).
                                        //   Best effort; [] on any failure.
export function inventory(project)      // → {rows, runners, workspaces, devServers} — composes the
                                        //   above; project=null → machine-wide (devServers only
                                        //   when project dir known → else []).
export function cleanDead(project)      // → string output of `bash <pkgroot>/bin/crew.sh prune`
                                        //   (RELAY_PROJECT env set when project given). This is the
                                        //   ONLY mutation and it only drops dead tracking rows.
```
pkgroot = resolve from this file's location (../..). Tests: temp HOME + RELAY_DATA_DIR, seeded
crew-windows.txt, stub `cmux`/`ps`/`lsof` on PATH as SEPARATE executables (never an in-process
stub blocked by spawnSync — the kimi overseer-test deadlock lesson). Never pgrep/kill anything
real. Run: `node test-resources.mjs` → "ALL PASS (n)", exit 0.

## #4215 glm — `hooks/sessionstart.mjs` (EDITS ONLY, S1+S2)
After the existing peer-roster context, using ONLY the #4214 exports:
- `liveRunners(project).length > 0` → append an ADOPT block to the injected context:
  `<trantor-resources>` … "a LIVE crew for <project> is already running (seats: agent(pid)…).
  ADOPT it: read relay_board, announce yourself to the seats over the bus, continue their work.
  Do NOT run `trantor up` over healthy seats — replace-in-place kills their context." …
  `</trantor-resources>`
- else if `listCrewRows()` has rows for this project → one line noting stale tracking rows exist
  and cleanup is running.
- Fire-and-forget `cleanDead(project)` via detached spawn (unref, stdio ignore) — NEVER awaited.
- Also list devServers(projectDir) in the block when non-empty (report only).
Hard limits: added latency <300ms (sync file reads fine; no awaited subprocess), fail-silent
(a thrown error must not break session start — wrap everything), sanitize() any injected text,
keep the block short (≤12 lines). Do not touch any other hook file.

## #4216 codex — `bin/patrol.mjs` + `test-patrol.mjs` + duty-doctrine edit in `bin/duty.mjs`
`node bin/patrol.mjs [--json] [--reap]`, machine-wide via #4214's `inventory(null)`:
- default: human-readable report — per project: tracked rows vs live runners vs cmux workspaces;
  flag ORPHANS (live runner with no tracking row / workspace named trantor:<proj> with no live
  runner / rows whose handles are dead) and AMBIGUOUS items separately.
- `--reap`: `cleanDead(null)` + delete stale artifacts ONLY: `~/.agent-bus/seats/*.sh` with no
  matching live runner and mtime >14d, and `kimi-startup-*.txt.consumed` / startup stashes >7d.
  NEVER kill a process. Print exactly what was removed.
- `--json`: `{projects:{...}, orphans:[...], ambiguous:[...], reaped:[...]}` stable shape.
- exit 0 always (report tool, not a gate).
Duty doctrine: in bin/duty.mjs find the RULES/doctrine string the duty seat receives; add a
PATROL step: each watch cycle run `node <root>/bin/patrol.mjs --json`; reap only when orphans
are provably dead; DM the human (sasha) about anything ambiguous (live orphan runner, dev
server >24h old); summarize actions in the on-watch broadcast. Do NOT touch bin/cli.mjs —
the orchestrator wires the `trantor patrol` route.
Tests mirror #4214's stub style. Run: `node test-patrol.mjs` → "ALL PASS (n)", exit 0.

## #4217 orchestrator — integration
cli.mjs `patrol` route + help text · contract enforcement · full `npm test` (append the two new
test files to package.json test chain) · release 0.17.63.

## Gate
Card flow todo→doing→testing→done. `testing` = your own test file green AND `node --check` on
every file you touched. Report on the bus with the card id. Contract drift → the orchestrator
bounces the card.
