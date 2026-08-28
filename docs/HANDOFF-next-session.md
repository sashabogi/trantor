# HANDOFF — first session after the 2026-08-19 restart

Written 2026-08-19, just before Sasha restarted the Mac. Replaces the 2026-08-12 version entirely.
**Intentionally untracked — keep it out of commits.**

Memory is the primary record (`MEMORY.md` loads every session). This file is the restart-specific
part: what the reboot destroyed, what comes back on its own, and what to do first.

---

## 1. Read this before you touch anything

The last session ended mid-diagnosis of **"the crew is failing"** in crebral-health. Sasha's
working theory was that a new Claude Code version had changed how agents communicate. That theory
did not survive the evidence. What was actually wrong was three unrelated faults stacked on top of
each other, and two are already resolved:

1. **Tailscale was stopped** (app running, tunnel off). Everything pinned to the remote hub timed
   out. Sasha reconnected it; verified healthy afterwards.
2. **The duty seat was dead on a quota wall**, not a protocol change. `err-claude-fleet.txt` said
   `You've reached your Fable 5 limit.` 12 consecutive exit-1 turns since 08-17 13:20. Sasha
   switched the default model to Opus 5; a probe with the seat's own invocation
   (`claude -p "…" --dangerously-skip-permissions`) then returned exit 0.
3. **The crebral-health seats never crashed at all.** Both launches (12:09, 12:42 on 08-18) brought
   up codex/glm/kimi/deepseek/openrouter, each ran its kickoff turn, exited 0, reported an empty
   inbox, and ended its turn correctly. They just never got a contract, because they registered on
   the local hub while the project is pinned to the remote one.

**Do not go looking for a crash.** There isn't one.

---

## 2. What the restart killed, and what returns by itself

| Thing | After reboot | Action |
|---|---|---|
| Local hub (launchd `com.trantor.hub`) | comes back automatically | verify `curl -s 127.0.0.1:4477/health` |
| Remote hub (netcup, systemd) | unaffected, it's another machine | verify `curl -s http://100.79.242.104:4477/health` |
| Tailscale | app auto-starts, but it was manually stopped once already | `tailscale status` must NOT say "stopped"; `pgrep tailscaled` must be non-empty |
| Duty seat (`claude:fleet`) | dead, plain process | `trantor duty up` |
| Bridge (`bin/bridge.mjs`, was pid 72342) | dead, plain process | leave it down (see §4) |
| crebral-health crew seats | already gone before the reboot | do not relaunch without Sasha |
| The crebral-health Claude session | gone | see §3 |

Health check for all of it in one pass:

```bash
tailscale status | head -3
curl -s 127.0.0.1:4477/health; echo
curl -s -m 8 http://100.79.242.104:4477/health; echo
trantor duty status
```

---

## 3. The one open question

I asked the live crebral-health session (`crebral-health-20`) what "continuously failing" looked
like from inside: the exact command, the literal error, the seat logs, when it started. It was busy
and the reboot killed it before it answered.

**Re-ask.** Use `ListAgents` to find the new crebral-health session, then `SendMessage`. What I need
from it, in order of usefulness:

1. the exact launch command and directory,
2. the literal error text it sees (not a paraphrase),
3. whether `trantor up` itself errors, or whether it succeeds and the crew just does nothing.

That last distinction is the whole fork in the road. Everything I can see on disk says the crew
launches fine and idles; if the session instead sees `trantor up` erroring, that's a fault I have
no evidence for yet, and one candidate worth testing is a permission prompt behaving differently
under CC 2.1.228.

Do not re-derive the split-brain from scratch. It's documented in the `trantor-hub-splitbrain`
memory with the full mechanism.

---

## 4. First actions, in order

**1. Release 0.17.69.** This is the top item. Four commits are pushed but unreleased, so npm and the
global CLI are still 0.17.68 and the crew hub-pin fix is not in effect. Until it ships, every
`trantor up` can rebind a crew to the wrong hub, which is the fault we've now chased twice.

Shipping in it:
- `4eac8a7` mechanical approvals (grants, `key` slug, revoke, `<trantor-grants>` session injection)
  plus the silent `signedGet` fix that had been killing every hub read in `sessionstart.mjs`,
- `cc545e9` crew hub binding: the project pin beats an inherited `RELAY_URL`, baked into each seat
  command, announced at launch, logged per seat,
- `6d7c675` the bridge plus its 18-test suite.

The release dance and its traps (plugin.json has its own version, netcup needs any changed `lib/`,
GitHub's ~60s cache, verify through `trantor app update` not the build dir) are in the
`trantor-gotchas` memory. Propose it to Sasha before running it — a push to the shared remote is a
real deploy.

**2. Bring the duty seat back**: `trantor duty up`. The quota latch clears on restart and the CLI
works again on Opus 5.

**3. Leave the bridge down.** It existed to paper over the split-brain for a live crew that no
longer exists. Restart it only if a crew is running against the wrong hub again; the command and
the safety property (the on-disk id-map makes restarts non-duplicating) are in the
`trantor-hub-splitbrain` memory.

**4. Then re-ask the crebral-health session** (§3).

---

## 5. Two traps that cost real time this session

**A quota-dead seat is indistinguishable from a broken bus, unless you read the err file.** On any
"the seats are failing", read `~/.agent-bus/err-<agent>-<project>.txt` FIRST. It holds the CLI's own
last words. The jsonl log gives you exit codes; only the err file gives you the reason. Also trust
the hub's own `🛑 … DOWN — needs trantor swap` broadcast: that is a real diagnosis, not noise. And
note a mixed crew fails *partially* under a Claude quota, because non-Claude seats are unaffected,
which reads as flakiness rather than a quota wall.

**RTK mangles `git log`, not just `grep`.** In `trantor-teams`, `git log --oneline -5 --decorate`
printed upstream/main's tip as if it were HEAD, with the teams merge commit missing. It read exactly
like a lost commit or a force-push, and I was one step from a destructive "recovery" on a healthy
repo. `git rev-parse HEAD` / `origin/main` through a python subprocess showed both at the merge
commit, clean, in sync. Never conclude anything about repo state from RTK-filtered `git log`.

---

## 6. Standing instruction from Sasha

Two separate times this week, something shipped that passed its unit tests and then failed silently
at a seam: the `signedGet` import that killed every hub read behind a swallowed exception, and the
crew hub binding. Sasha named this directly and was frustrated by it. The expectation going forward
is to verify live wiring end to end at launch and release time, not only in the suite. The bridge
was built that way on purpose (two-hub integration test before it touched anything real, then
verified against the live boards), and that is the bar to keep.

Also standing: no killing or relaunching a working crew mid-build to fix tooling. Work alongside it.
