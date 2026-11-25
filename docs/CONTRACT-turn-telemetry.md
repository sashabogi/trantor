# Contract: turn telemetry (runner to hub)

Card #14059. Status: proposed 2026-11-24, not built. This document is the source of truth for how a
seat's turn records reach the hub. Code that contradicts it is the bug.

## The problem

The Usage screen showed 0 turns for 14 days on a day when two seats ran about 25 turns.

- The hub builds `GET /learning` from `scanTelemetry()` in `hub/routes/insights.mjs`, which lists
  `homedir()/.agent-bus/logs/*.jsonl` on the hub's own machine and returns an empty cache when the
  folder cannot be read.
- On netcup the hub runs as user `trantor` with `HOME=/var/lib/trantor`. That folder does not exist.
- Seat runners run as `root` and write `/root/.agent-bus/logs/<persona>-<project>.jsonl`
  (`bin/crew-runner.mjs`, the `telemetry()` helper). `/root` is mode 700.

So the hub has had no turn data since the seats and the hub moved to netcup. Everything derived from
it is empty: Usage turns and wasted turns, per-agent reliability, the Learning series. The design
was only ever right when the hub and every seat shared one home directory.

## Decisions

1. **Runners report turns to the hub over the signed bus.** The hub never reads another process's
   home directory. `scanTelemetry()` is deleted, with no fallback to a local folder.
2. **The local jsonl file stays.** It is the runner's write-ahead log and what same-machine tools
   read (`lib/seat-why.mjs`, `lib/seat-record.mjs`, `bin/duty.mjs`, `bin/orchestrate.mjs`). Nothing
   about it changes.
3. **Delivery is at-least-once, and the hub removes duplicates.** A turn is never lost because the
   hub was unreachable, and never counted twice because a post was retried.
4. **Only turn rows are turns.** Boot rows and text notes are not counted. Today any row with an
   `agent` field is counted, which inflates the numbers.
5. **A failed turn is defined by its outcome, not its raw exit code.** Today a turn that exits 0
   but is classified failed is counted as a success.

## The row

The row is the one the runner already writes at the end of every turn, plus three fields.

| Field | Meaning |
|---|---|
| `id` | New. `sha256(persona, project, ts, turn)` as 32 hex characters. The duplicate key. |
| `v` | New. Schema version, `1`. |
| `machine` | New. The machine label the runner already reports for presence (`MACHINE_LABEL`). |
| `ts` | Turn end, epoch ms. |
| `persona`, `agent`, `project` | Seat instance (`glm-5`), its agent (`glm`), its project. |
| `turn`, `trigger`, `card` | Turn number since boot, what woke it, the card it worked (0 for none). |
| `model`, `duration_ms`, `tokens`, `usage` | As written today. `tokens` 0 means not reported. |
| `exit`, `effExit`, `outcome`, `verdict` | As written today. `verdict` is cut to 600 characters. |
| `cut`, `stalled`, `cutSignal`, `extensions`, `boxMs`, `containers` | Optional, as today. |

Outcomes, as the runner names them today: `completed`, `asked`, `blocked`, `no-delivery`, `empty`,
`stalled`, `cut`, `rejected`, `api-error`.

- **Failed** means any outcome except `completed`, `asked` and `blocked`.
- **Wasted** is the same set: the turn cost time or tokens and delivered nothing.

A row carries no prompt text and no output text.

## Runner: shipping

- After writing a row locally, the runner posts every unshipped turn row for its seat to the hub,
  oldest first, at most 100 per request, with a 2 second timeout. It does not wait on the result
  before going idle, and a failure never fails the turn.
- The cursor is a byte offset in `~/.agent-bus/logs/.shipped-<persona>-<project>`. It advances only
  after the hub answers 200. A missing cursor means ship from the start of the file.
- The runner also ships at boot, so rows written while the hub was down go out without waiting for
  the next turn.
- When shipping fails, the runner logs one line per episode (first failure, then recovery), not one
  per attempt. This follows the monitoring doctrine.
- `trantor telemetry ship [--all]` does the same from the command line for one seat or for every
  file in the folder. It is how existing history is sent once, on netcup and on the Mac. Each
  file's rows are signed with that seat's own instance key when the key is still on the machine.

## Hub: receiving and storing

`POST /telemetry/turns` with body `{ rows: [...] }`.

- Signed, like every write. The signer must be the seat the rows name: `auth.identity.name` equals
  `<persona>:<project>`. A row for another seat is refused with 403. The owner key may post rows for
  any seat: the one-time history send needs that for seats whose key no longer exists.
- Each row is validated (types, lengths, `ts` not in the future by more than a minute, `turn` a
  positive integer). An invalid row is dropped and counted in the reply; it does not fail the batch.
- Reply: `{ ok: true, stored, duplicates, dropped }`.

Storage is separate from the event log. The event log is capped at 20,000 entries and shared with
card history; a busy fleet would push card events out within days.

- Postgres: a `turns` table keyed by `(org_id, id)`, with `ts`, `project`, `agent`, `persona`,
  `machine`, `outcome`, `model`, `duration_ms`, `tokens`, `card`, and the whole row as JSON. Insert
  with `ON CONFLICT DO NOTHING`; a conflict is a duplicate and is counted as one.
- File store: `turns.jsonl` beside the hub's data file, compacted at boot.
- Retention: 180 days, pruned daily.
- In memory the hub keeps per-day totals by project and agent, rebuilt at boot from the store, so
  `/learning` never scans raw rows on a request.

## Hub: serving

- `GET /learning` keeps its shape. Its per-agent reliability and daily series come from the stored
  turns. Failures use the outcome rule above.
- `GET /telemetry/turns?project=&agent=&since=&until=&limit=` returns raw rows, newest first, at
  most 1,000. This is what lets Usage show wasted turns by cause and an hour-by-weekday view again
  (both were removed in #14054 because the hub had no data), and what lets a seat on another machine
  be explained from the app.
- `GET /health` gains `telemetry: { lastRowTs, rows24h }`.

## What the app says

Usage never shows a bare 0 again. When the hub has no rows in the range, the screen says when the
last turn was reported, or that no runner has reported at all. A silent zero is what hid this for
weeks.

## Out of scope

- Orchestrator sessions in Claude Code panes. They are not runner turns. Their usage comes from the
  provider meters.
- The Scrooge ledger. `/learning` still reads `~/.token-scrooge` on the hub's machine, which has the
  same flaw. It gets its own card.
- Prompt or output text.

## Slices

Each is one card with one owner. The row table and the endpoint above are the interface between
them.

1. **Hub**: `POST /telemetry/turns`, the store for both backends, retention, the `/health` field.
   Files: `hub/routes/insights.mjs`, `lib/store-pg.mjs`, `hub/migrations.mjs`, `hub/store.mjs`.
2. **Runner**: the three new row fields, the shipper and its cursor, the episode log line, the
   `trantor telemetry ship` command. Files: `bin/crew-runner.mjs`, a new `lib/telemetry-ship.mjs`,
   `bin/cli.mjs`.
3. **Read path**: `/learning` reads the store, `scanTelemetry()` is deleted, `GET /telemetry/turns`,
   and the Usage empty state. Depends on 1.
4. **Later**: Usage by cause and by hour, and the app explaining a remote seat.

## Drill

1. Deploy the hub slice to netcup. `GET /health` shows `telemetry` with `rows24h` 0.
2. On netcup run `trantor telemetry ship --all` as root. The reply counts about 240 stored rows.
   Run it again: the same rows come back as duplicates and the stored count does not move.
3. Give a seat one contract. Within seconds of its turn ending, `rows24h` goes up by one.
4. Stop the hub, let a seat finish a turn, start the hub. The seat's next boot or turn ships the
   missed row. The runner's log has one "could not report turns" line and one recovery line.
5. Open Usage in the Preview app, 14 days: Turns is above zero, today has a bar, By agent lists the
   seats that worked.
6. From a second seat, post a row that names the first seat. The hub answers 403.

## Open questions for the operator

1. Retention of 180 days: enough?
2. History before tonight exists only where a local log survived (about 240 rows on netcup, plus
   whatever the Mac has). Earlier days stay empty. Acceptable?
3. Should a failed post ever surface to you, or is the runner's log line plus the `/health` field
   enough?
