# netcup capacity: how many seats can one machine run?

Card #13942, measured 2026-11-20 23:43–00:17 CET by the orchestrator, directly on netcup (scripts `/root/loadtest-13942.sh`, `/root/loadtest-13942b.sh`). Question from the operator: with 5 projects and many seats each, can one machine run 20–30 agents at once?

## The machine

- 16 cores, 62 GB RAM (about 36 GB already used by other services, 26 GB available), 2 TB disk (490 GB used), no swap use observed.
- The production Trantor hub runs on the same machine.

## What an agent costs

| State | Cost |
|---|---|
| Idle seat (runner + CLI) | 67–78 MB RSS each (codex-7, kimi-9, glm-5) |
| Seat worktree on disk | 0.4–2.5 GB each, mostly `desktop/src-tauri/target` |

Thirty idle seats is about 2–3 GB of RAM. Idle seats are not the limit.

## What a working seat costs: the heaviest real gate

Each slot ran in its own git worktree at `origin/main` (f84e0813), concurrently. Samples every 10 s.

### Round 1: `cargo test` in desktop/src-tauri (own CARGO_TARGET_DIR per slot)

| N concurrent | Wall per slot | Peak load | Peak RAM used | Swap | Failures |
|---:|---:|---:|---:|---:|---|
| 3 | 187–191 s | 38 | 41.9 GB | 0 | none |
| 6 | 90–189 s | 47 | 42.3 GB | 0 | none |
| 10 | 76–224 s | 68 | 43.9 GB | 0 | 6 of 10 slots: 1 failure each, `graft_cli::...drill_real_checkout...` |

The N=10 failure is one graft-dependent drill test (graft is not installed on netcup), which passed at N=3 and N=6. It is a timing-sensitive environment test, not a build or memory failure.

### Round 2: the whole root suite (`npm test`, 250 suites incl. desktop vitest)

Dependencies linked from a seat worktree (netcup has no pnpm; round 1's suites never started for that reason).

| N concurrent | Wall per slot | Peak load | Peak RAM used | Swap | Red suites per slot |
|---:|---:|---:|---:|---:|---|
| 3 | 333–334 s | 30 | 39.2 GB | 0 | 6–7 |
| 6 | 405–409 s | 111 | 43.9 GB | 0 | 7–8 |
| 10 | 543–564 s | 249 | 50.2 GB | 0 | 9–11 |

Baseline reds on netcup are 6–8 suites at any load: graft/sqlite3 missing and macOS-only duty-seat suites (green on the Mac). The extra 2–3 reds at N=10 are load-induced: timing-sensitive suites failing under CPU starvation.

### Hub latency during the runs

Local `curl /health` on netcup: worst 1.36 s (round 1) and 1.74 s (round 2). Idle baseline measured the same evening: 0.002–1.22 s, bimodal. Load adds little; the hub is slow on its own (card #13947).

## What this says

1. **RAM is not the limit.** Ten concurrent full suites peaked at 50 GB of 62 with no swap. Thirty mostly-idle seats fit easily.
2. **CPU is the limit, and it degrades gracefully but not cleanly.** At 10 concurrent full suites, load hit 249 on 16 cores. Wall time grew only about 65% (334 s to 555 s), so work still finishes, but 2–3 timing-sensitive suites per run go red. Red-from-load is the dangerous part: a seat cannot tell a load flake from a real regression, and our gate trusts reds.
3. **The hub shares the box.** It stayed up and answered throughout (worst 1.74 s), but every heavy gate competes with it for CPU.

## Extrapolation to 20–30 seats

Real crews are mostly idle: seats spend most of a turn thinking or waiting on an API, and run heavy gates in bursts. Assuming a quarter to a third of seats are in a heavy gate at the same moment:

| Seats | Heavy gates at once (est.) | Expected behavior without a limit |
|---:|---:|---|
| 10 | 2–4 | Fine (round 2 N=3: no load-induced reds) |
| 20 | 5–7 | Load around 100+, occasional load-induced reds |
| 30 | 8–10 | Load 200+, regular load-induced reds, slower hub |

These are estimates from the measured points, not measurements at 20–30.

## Recommendation

netcup can host 20–30 seats **if heavy gates take turns**. Without that, it will hold up but start producing false reds around 6+ concurrent gates. In order:

1. **Concurrency limit for heavy commands** (#13942 step 2): a machine-wide semaphore seats acquire before a full suite or cargo build, sized to about 4 concurrent heavy gates on this machine (configurable per machine). Measured: N=3 finished without load-induced reds.
2. **Fix the hub's slow `/health`** (#13947), since it sits on the same box.
3. **Disk janitor on Linux** (#13942 step 3): seat worktrees reach 2.5 GB each and nothing prunes them on netcup today.
4. **Install pnpm on netcup** so seat worktrees get real dependency installs instead of borrowing (round 1 lost its suite data to this).
5. Consider moving the hub off the build machine once crews grow, or pinning it to reserved cores.
