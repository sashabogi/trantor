# CARD LOG CONTRACT — board-integrity build (2026-08-20) — FROZEN

Why: a card's story lived in side channels that rot (bus messages citing "#id" break on id
remap; events are retention-pruned at 90d). The story now lives ON the card. Also: the todo
lane had no lifecycle owner — cards rotted invisibly forever.

## The log field (P1 owns the hub side)
- `task.log` = array of `{ ts: <ms>, by: <string ≤120>, text: <string ≤2000> }`.
- Cap 40 entries per card; on overflow drop the OLDEST.
- `POST /task` accepts optional `note` (string) → seeds `log[0]` with by = b.by.
- `POST /task/update` accepts optional `note` → APPENDS an entry (by = b.by). A note-only
  update (no status/title change) is legal: bumps `updated`, appends `updated` cardEvent.
- `log` needs no new persistence work: unknown task keys ride `tasks.extra` (lib/store-pg.mjs
  taskExtra) — but P1's test must assert log survives a hub restart round-trip.
- `GET /tasks` and `GET /card` return `log` as part of the task object (automatic).

## Todo lifecycle (P1)
- reapStaleCards: a `todo` card untouched — `(updated || ts)` — for RELAY_TODO_STALE_MS
  (env, default 14 days) moves to `stale`, history entry by "reaper", plus a log note
  "todo aged out after <N>d untouched".
- Boot backfill, idempotent, every boot: if `t.ts` is falsy → `t.ts = history[0]?.ts ||
  t.updated || now()`; mark dirty. (Migration left old cards with ts:0.)

## MCP surface (P2)
- `relay_task_add` gains optional `note` (≤2000 chars) → passed as `note` on POST /task.
- `relay_task_move` gains optional `note` → passed on POST /task/update. Description must
  tell the model: "attach WHAT YOU DID as note when moving to testing/done — the note is
  the card's durable story; a bare status move is a defect for crew work".
- relay_board output: cards with a log show `·N` note-count after the id.

## Desktop (P3)
- `client.ts` Card type gains `log?: { ts: number; by: string; text: string }[]`.
- CardDetail: render log entries as the primary story block (chronological, by + time +
  text), ABOVE the events/messages timeline. Events/messages stay as supplement.
- Board todo tiles: an age badge ("14d") when a todo card is >7 days untouched; muted
  color <14d, warn color ≥14d. Age = now - (updated || ts).

## Duty + retention (P4)
- bin/duty.mjs prompt: when relaying an undelivered DM as a card, put the FULL message
  body in `note` (title stays a short headline); when the target ACKs (replies on the bus
  or the DM is consumed), move the relay card to done WITH a note naming the ack.
- deploy/retention.sh: the DELETE gets `AND type NOT IN (<card event types>)` — read the
  exact type strings from hub.mjs isCardEvent. Card events are the timeline spine; they
  must survive the 90-day purge.

## Hard rules
- File ownership: P1 = hub.mjs + test-cardlog.mjs ONLY. P2 = mcp.mjs + test-relay-note.mjs
  ONLY. P3 = desktop/src/** ONLY. P4 = bin/duty.mjs + deploy/retention.sh ONLY.
- NOBODY edits package.json — the orchestrator wires test files into npm test at integration.
- Card flow todo → doing → testing → done; testing = run YOUR test file + node --check on
  files you touched (P3: npx tsc --noEmit -p desktop/tsconfig.json).
- Report done on the bus citing your card id AND move the card with a note (dogfood the
  feature you are building).
