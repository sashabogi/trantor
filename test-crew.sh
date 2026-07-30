#!/bin/bash
# trantor crew teardown-scoping tests (2026-07-20).
#
# The bug: crew.sh v2 tracked ALL crew windows in one global ~/.agent-bus/crew-windows.txt as bare
# `AGENT<TAB>WID` rows (no project), so `trantor down` from ANY session killed EVERY crew on the machine.
# v3 rows are `PROJECT<TAB>KIND<TAB>AGENT<TAB>HANDLE` and `down` is PROJECT-SCOPED. These tests run the REAL
# down() against a temp HOME with STUBBED osascript/tmux (no windows spawned, no tmux needed) and assert
# which STATE rows survive. This is the safety fix — one session's teardown must never touch another's crew.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0
ok(){ if eval "$2"; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  [$2]"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/.agent-bus" "$TMP/fakebin"
# stub osascript: log any AppleScript (stdin heredoc, e.g. cmux close-tab) so we can assert on it; a query
# for a window id returns nothing (no tty, nothing killed); everything succeeds.
cat > "$TMP/fakebin/osascript" <<EOF
#!/bin/bash
cat >> "$TMP/osa.log" 2>/dev/null </dev/stdin
exit 0
EOF
# stub tmux: record kills, always succeed; has-session says "no" so nothing is considered alive.
cat > "$TMP/fakebin/tmux" <<EOF
#!/bin/bash
echo "tmux \$*" >> "$TMP/tmux.log"
case "\$1" in has-session) exit 1;; esac
exit 0
EOF
chmod +x "$TMP/fakebin/osascript" "$TMP/fakebin/tmux"
# stub cmux: log every socket call so we can assert teardown scoping; `ping` succeeds so _cmux_ok picks the
# socket path (not the AppleScript fallback).
cat > "$TMP/fakebin/cmux" <<EOF
#!/bin/bash
echo "cmux \$*" >> "$TMP/cmux.log"
case "\$1" in ping) exit 0 ;; esac
exit 0
EOF
chmod +x "$TMP/fakebin/cmux"
# a second stub dir WITHOUT tmux, to exercise the Terminal-window fallback path
mkdir -p "$TMP/fakebin_notmux"; cp "$TMP/fakebin/osascript" "$TMP/fakebin_notmux/osascript"
STATE="$TMP/.agent-bus/crew-windows.txt"
seed(){ printf '%b' "$1" > "$STATE"; }
rows(){ [ -f "$STATE" ] && wc -l < "$STATE" | tr -d ' ' || echo 0; }
has_row(){ [ -f "$STATE" ] && grep -qF "$1" "$STATE"; }
downcmd(){ HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT="$1" bash "$ROOT/bin/crew.sh" down "${@:2}" </dev/null; }

echo "# trantor crew teardown-scoping tests"

# A four-seat, two-project board + a legacy (project-less) row.
SEED="crebral-health\twin\tcodex\t100\ncrebral-health\twin\tglm\t101\nbuiltbetter\twin\tkimi\t200\nbuiltbetter\twin\tdeepseek\t201\n"

# 1. down scoped to crebral-health leaves builtbetter's crew ALONE
seed "$SEED"
downcmd crebral-health >/dev/null 2>&1
ok "scoped down removes THIS project's rows" '! has_row "crebral-health"'
ok "scoped down KEEPS the other project's rows" 'has_row "builtbetter	win	kimi	200" && has_row "builtbetter	win	deepseek	201"'
ok "two builtbetter rows survive" '[ "$(rows)" = "2" ]'

# 2. down --all WITHOUT --yes changes nothing (prints only)
seed "$SEED"
downcmd crebral-health --all >/dev/null 2>&1
ok "down --all without --yes is a no-op (safety)" '[ "$(rows)" = "4" ]'

# 3. down --all --yes tears everything down
seed "$SEED"
downcmd crebral-health --all --yes >/dev/null 2>&1
ok "down --all --yes clears every row" '[ "$(rows)" = "0" ]'

# 4. per-seat: down <agent> removes only that seat
seed "$SEED"
downcmd crebral-health codex >/dev/null 2>&1
ok "per-seat down removes only that agent" '! has_row "crebral-health	win	codex	100"'
ok "per-seat down keeps the sibling seat" 'has_row "crebral-health	win	glm	101"'
ok "per-seat down keeps the other project intact" 'has_row "builtbetter	win	kimi	200"'

# 5. legacy (project-less, pre-v3) rows are NOT swept by a project-scoped down — we can't prove they're ours,
#    and killing another project's crew is the exact bug we're fixing. Only --all reaches them.
seed "codex\t900\nglm\t901\nbuiltbetter\twin\tkimi\t200\n"
downcmd crebral-health >/dev/null 2>&1
ok "scoped down does NOT sweep legacy project-less rows" 'has_row "codex	900" && has_row "glm	901"'
ok "scoped down leaves foreign-project rows alone too" 'has_row "builtbetter	win	kimi	200"'
seed "codex\t900\nglm\t901\nbuiltbetter\twin\tkimi\t200\n"
downcmd crebral-health --all --yes >/dev/null 2>&1
ok "down --all --yes DOES reach legacy rows" '! has_row "codex	900"'

# 6. tmux rows: whole-project down kills the session; another project's tmux session is untouched
seed "crebral-health\ttmux\tcodex\t%1\ncrebral-health\ttmux\tglm\t%2\ncrebral-health\tattach\t__win__\t300\nbuiltbetter\ttmux\tkimi\t%9\n"
rm -f "$TMP/tmux.log"
downcmd crebral-health >/dev/null 2>&1
ok "tmux whole-project down kills trantor:crebral-health" 'grep -q "kill-session -t trantor:crebral-health" "$TMP/tmux.log"'
ok "tmux down does NOT kill the other project's session" '! grep -q "kill-session -t trantor:builtbetter" "$TMP/tmux.log"'
ok "the other project's tmux row survives STATE rewrite" 'has_row "builtbetter	tmux	kimi	%9"'

# 7. unknown flag → usage + nonzero exit
seed "$SEED"
if HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=crebral-health bash "$ROOT/bin/crew.sh" down --bogus >/dev/null 2>&1; then rc=0; else rc=1; fi
ok "unknown flag is rejected (nonzero exit)" '[ "$rc" = "1" ]'
ok "unknown flag changes nothing" '[ "$(rows)" = "4" ]'

# 8. spawn dry-run forced to tmux → one grouped session, a named pane per seat, an attached window
OUT8="$(CREW_MUX=tmux CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj bash "$ROOT/bin/crew.sh" up codex glm 2>&1)"
ok "tmux spawn creates the project session" 'echo "$OUT8" | grep -q "tmux new-session -d -s .trantor:testproj"'
ok "tmux spawn adds a pane for the 2nd seat" 'echo "$OUT8" | grep -q "tmux split-window"'
ok "tmux spawn names panes by seat" 'echo "$OUT8" | grep -qi "select-pane .* -T"'
ok "tmux spawn attaches ONE Terminal window" 'echo "$OUT8" | grep -qi "would attach a Terminal window"'
ok "tmux spawn does no bus verify in dry mode" 'echo "$OUT8" | grep -q "dry run: no bus verify"'

# 9. spawn dry-run forced to Terminal fallback → per-agent windows + the hint
OUT9="$(CREW_MUX=terminal CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin_notmux:/usr/bin:/bin" RELAY_PROJECT=testproj bash "$ROOT/bin/crew.sh" up codex glm 2>&1)"
ok "terminal fallback hints a multiplexer (cmux/tmux)" 'echo "$OUT9" | grep -qiE "install cmux|brew install tmux"'
ok "terminal fallback spawns per-agent windows" 'echo "$OUT9" | grep -qi "Terminal window for"'

# 10. cmux teardown scoping (SOCKET): whole-project down closes THIS project's workspace, not another's
seed "crebral-health\tcmuxws\t__ws__\tTAB-CH\ncrebral-health\tcmux\tcodex\tTERM-1\ncrebral-health\tcmux\tglm\tTERM-2\nbuiltbetter\tcmuxws\t__ws__\tTAB-BB\nbuiltbetter\tcmux\tkimi\tTERM-9\n"
rm -f "$TMP/cmux.log"
downcmd crebral-health >/dev/null 2>&1
ok "cmux down calls close-workspace on THIS project" '[ -f "$TMP/cmux.log" ] && grep -q "close-workspace --workspace TAB-CH" "$TMP/cmux.log"'
ok "cmux down does NOT close the other project's workspace" '! grep -q "TAB-BB" "$TMP/cmux.log" 2>/dev/null'
ok "the other project's cmux rows survive" 'has_row "builtbetter	cmuxws	__ws__	TAB-BB" && has_row "builtbetter	cmux	kimi	TERM-9"'
ok "this project's cmux rows are gone" '! has_row "crebral-health"'

# 11. cmux per-seat down → close-surface on one seat, keeps the workspace + siblings
seed "crebral-health\tcmuxws\t__ws__\tTAB-CH\ncrebral-health\tcmux\tcodex\tTERM-1\ncrebral-health\tcmux\tglm\tTERM-2\n"
rm -f "$TMP/cmux.log"
downcmd crebral-health codex >/dev/null 2>&1
ok "cmux per-seat down calls close-surface on that seat" 'grep -q "close-surface --surface TERM-1" "$TMP/cmux.log"'
ok "cmux per-seat down does NOT close the whole workspace" '! grep -q "close-workspace" "$TMP/cmux.log"'
ok "cmux per-seat down keeps the sibling seat + workspace" 'has_row "crebral-health	cmux	glm	TERM-2" && has_row "crebral-health	cmuxws	__ws__	TAB-CH"'

# 12. cmux SOCKET spawn dry-run → one workspace (new-workspace) + a split per extra seat
OUT12="$(CREW_MUX=cmux CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj bash "$ROOT/bin/crew.sh" up codex glm deepseek 2>&1)"
ok "cmux spawn creates ONE workspace via new-workspace" 'echo "$OUT12" | grep -q "cmux: new-workspace (cwd"'
ok "cmux spawn tiles extra seats via new-split" '[ "$(echo "$OUT12" | grep -c "cmux: new-split")" = "2" ]'
ok "cmux spawn reports the grouped workspace + sidebar status" 'echo "$OUT12" | grep -q "seats tiled + sidebar status"'

# 13. cmux GRID tiling: 4 seats = 2×2 — row 0 splits RIGHT off the previous column, row 1 splits DOWN
# from the pane directly above (surface-targeted, never focus-dependent; the old staircase regression)
OUT13="$(CREW_MUX=cmux CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj bash "$ROOT/bin/crew.sh" up codex glm deepseek kimi 2>&1)"
ok "cmux 4-seat grid: seat 2 splits RIGHT from seat 1" 'echo "$OUT13" | grep -q "new-split right --surface %DRYT0"'
ok "cmux 4-seat grid: seat 3 splits DOWN from seat 1" 'echo "$OUT13" | grep -q "new-split down --surface %DRYT0"'
ok "cmux 4-seat grid: seat 4 splits DOWN from seat 2" 'echo "$OUT13" | grep -q "new-split down --surface %DRYT1"'

# 14. reap-on-up regression (2026-07-29): `trantor up <agent>` REPLACES a live runner for the same
# agent+project instead of stacking a duplicate (the 17-runner incident: N runners long-polling ONE
# inbox, every contract waking all of them). Three properties, proven against REAL decoy processes:
#   a. the reap happens, and its output is VISIBLE — i.e. it runs in resolve_spec() as a plain
#      statement, not inside RUN_CMD, whose `cmd="$(RUN_CMD)"` call would swallow it into the
#      launcher string (the exact placement bug the fix moved it away from);
#   b. it is scoped to agent+project: a different agent on the same project survives;
#   c. the pgrep pattern is ANCHORED: the same agent in ".../proj2" must survive a reap for
#      ".../proj" — an unanchored pattern kills siblings on a directory-name prefix collision.
mkdir -p "$TMP/proj" "$TMP/proj2"
printf 'setInterval(() => {}, 1 << 30);\n' > "$TMP/crew-runner.mjs"
node "$TMP/crew-runner.mjs" codex "$TMP/proj"  & DECOY_SAME=$!
node "$TMP/crew-runner.mjs" glm   "$TMP/proj"  & DECOY_AGENT=$!
node "$TMP/crew-runner.mjs" codex "$TMP/proj2" & DECOY_PREFIX=$!
sleep 0.5
OUT14="$(cd "$TMP/proj" && CREW_MUX=cmux CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj bash "$ROOT/bin/crew.sh" up codex 2>&1)"
ok "up reaps the live runner for the SAME agent+project" 'echo "$OUT14" | grep -q "^\[dry\] kill -9 $DECOY_SAME "'
ok "the reap is not swallowed into the launcher string" '! echo "$OUT14" | grep -v "^\[dry\] kill -9" | grep -q "kill -9 $DECOY_SAME"'
ok "up does NOT reap a different agent on the same project" '! echo "$OUT14" | grep -q "kill -9 $DECOY_AGENT"'
ok "up does NOT reap the same agent in a prefix-named sibling dir" '! echo "$OUT14" | grep -q "kill -9 $DECOY_PREFIX"'
kill -9 "$DECOY_SAME" "$DECOY_AGENT" "$DECOY_PREFIX" 2>/dev/null
wait 2>/dev/null || true

echo ""
if [ "$FAIL" = "0" ]; then echo "ALL PASS ($PASS)"; else echo "$FAIL FAILED"; fi
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
