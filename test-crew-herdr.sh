#!/bin/bash
# herdr mux tests (card #5345, P0-B): CREW_MUX=herdr is an EXPLICIT opt-in — herdr is never
# auto-detected, and every other mux path (cmux/tmux/terminal) stays untouched. herdr is not
# installed on this machine, so every drill runs the REAL crew.sh against a temp HOME with a STUB
# herdr (counter-unique JSON ids, exactly the capture-don't-predict contract of the real CLI).
# The osascript stub CATS STDIN — every crew.sh invocation here carries </dev/null (hung-suite
# lesson, 2026-08-20).
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0
ok(){ if eval "$2"; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  [$2]"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/.agent-bus" "$TMP/fakebin" "$TMP/proj"
cat > "$TMP/fakebin/osascript" <<EOF
#!/bin/bash
cat >> "$TMP/osa.log" 2>/dev/null </dev/stdin
exit 0
EOF
cat > "$TMP/fakebin/tmux" <<EOF
#!/bin/bash
echo "tmux \$*" >> "$TMP/tmux.log"
case "\$1" in has-session) exit 1;; esac
exit 0
EOF
cat > "$TMP/fakebin/cmux" <<EOF
#!/bin/bash
echo "cmux \$*" >> "$TMP/cmux.log"
case "\$1" in ping) exit 0 ;; esac
exit 0
EOF
# stub herdr: logs every call; create/split print counter-unique JSON ids (the real CLI's
# capture-don't-predict contract); `workspace list` replays \$HERDR_LIVE_WS for the prune drills.
cat > "$TMP/fakebin/herdr" <<EOF
#!/bin/bash
echo "herdr \$*" >> "$TMP/herdr.log"
case "\$1" in
  workspace) case "\$2" in
    create) N=\$(( \$(cat "$TMP/herdr.n" 2>/dev/null || echo 0) + 1 )); echo "\$N" > "$TMP/herdr.n"
            printf '{"result":{"workspace":{"workspace_id":"WS-%s"},"tab":{"tab_id":"T-%s"},"root_pane":{"pane_id":"P-%s"}}}\n' "\$N" "\$N" "\$N" ;;
    list)   if [ -n "\${HERDR_LIVE_WS:-}" ]; then printf '{"result":{"workspaces":[%s]}}' "\$HERDR_LIVE_WS"
            else printf '{"result":{"workspaces":[]}}'; fi ;;
  esac ;;
  pane) case "\$2" in
    split) N=\$(( \$(cat "$TMP/herdr.n" 2>/dev/null || echo 0) + 1 )); echo "\$N" > "$TMP/herdr.n"
           printf '{"result":{"pane":{"pane_id":"P-%s"}}}\n' "\$N" ;;
  esac ;;
esac
exit 0
EOF
chmod +x "$TMP/fakebin/"*
# a PATH with NO herdr at all (opt-in-without-binary drill)
mkdir -p "$TMP/fakebin_noherdr"; cp "$TMP/fakebin/osascript" "$TMP/fakebin/tmux" "$TMP/fakebin_noherdr/"
STATE="$TMP/.agent-bus/crew-windows.txt"
seed(){ printf '%b' "$1" > "$STATE"; }
rows(){ [ -f "$STATE" ] && wc -l < "$STATE" | tr -d ' ' || echo 0; }
has_row(){ [ -f "$STATE" ] && grep -qF "$1" "$STATE"; }
nolog(){ [ ! -f "$TMP/herdr.log" ] || ! grep -q . "$TMP/herdr.log"; }

echo "# herdr mux tests (CREW_MUX=herdr explicit opt-in)"

# 1. opting in WITHOUT the binary → hard error + install hint; nothing spawned, nothing recorded
if (cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin_noherdr:/usr/bin:/bin" RELAY_PROJECT=testproj CREW_MUX=herdr bash "$ROOT/bin/crew.sh" up codex </dev/null >/dev/null 2>&1); then rc=0; else rc=1; fi
ok "CREW_MUX=herdr without herdr installed is a HARD error" '[ "$rc" = "1" ]'
OUT1="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin_noherdr:/usr/bin:/bin" RELAY_PROJECT=testproj CREW_MUX=herdr bash "$ROOT/bin/crew.sh" up codex </dev/null 2>&1)"
ok "the error says how to install herdr (user-local, no sudo)" 'echo "$OUT1" | grep -q "herdr is not installed"'
ok "failed opt-in records no state" '[ "$(rows)" = "0" ]'

# 2. opt-in ONLY: herdr on PATH but CREW_MUX unset → the default dispatch never invokes herdr
OUT2="$(cd "$TMP/proj" && CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 bash "$ROOT/bin/crew.sh" up codex </dev/null 2>&1)"
ok "default dispatch still prefers cmux (herdr ignored)" 'echo "$OUT2" | grep -q "seats tiled + sidebar status"'
ok "an un-opted run NEVER invokes herdr" 'nolog'

# 3. the tmux path is untouched by herdr's presence
rm -f "$TMP/herdr.log" "$TMP/tmux.log"
OUT3="$(cd "$TMP/proj" && CREW_MUX=tmux CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 bash "$ROOT/bin/crew.sh" up codex glm </dev/null 2>&1)"
ok "tmux path still groups into the project session" 'echo "$OUT3" | grep -q "tmux new-session -d -s .trantor:testproj"'
ok "tmux path never invokes herdr" 'nolog'

# 4. CREW_MUX=herdr dry spawn: ONE workspace, root pane runs seat 1, RIGHT split for seat 2
rm -f "$TMP/herdr.log"
OUT4="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj CREW_HUB=http://10.7.7.7:4477 bash "$ROOT/bin/crew.sh" up codex glm </dev/null 2>&1)"
ok "announces the herdr grouping UI" 'echo "$OUT4" | grep -q "bringing up crew for testproj (herdr)"'
ok "creates ONE workspace labeled trantor:<project>" 'echo "$OUT4" | grep -q "herdr: workspace create (cwd" && echo "$OUT4" | grep -q "trantor:testproj"'
ok "seat 2 arrives via a RIGHT split off seat 1" 'echo "$OUT4" | grep -q "pane split %DRYT0 --direction right"'
ok "two seats spawned" '[ "$(echo "$OUT4" | grep -c "seat in herdr workspace")" = "2" ]'
ok "the runner command rides pane run, hub binding baked in" 'echo "$OUT4" | grep -q "crew-runner\.mjs codex" && echo "$OUT4" | grep -q "RELAY_URL=http://10.7.7.7:4477"'
ok "herdr spawn summary names the workspace + scoped teardown" 'echo "$OUT4" | grep -q "crew grouped in herdr"'
ok "dry spawn does no bus verify" 'echo "$OUT4" | grep -q "dry run: no bus verify"'

# 5. grid tiling for 4 seats — same ceil(√N) doctrine as cmux: row 0 RIGHT, later rows DOWN
OUT5="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 bash "$ROOT/bin/crew.sh" up codex glm deepseek kimi </dev/null 2>&1)"
ok "4-seat grid: seat 2 splits RIGHT from seat 1" 'echo "$OUT5" | grep -q "pane split %DRYT0 --direction right"'
ok "4-seat grid: seat 3 splits DOWN from seat 1" 'echo "$OUT5" | grep -q "pane split %DRYT0 --direction down"'
ok "4-seat grid: seat 4 splits DOWN from seat 2" 'echo "$OUT5" | grep -q "pane split %DRYT1 --direction down"'

# 6. replace-never-stack: a second up REUSES the newest tracked workspace; older stacks are closed.
#    Dry mode reads STATE read-only, so the board can be seeded (same contract as the cmux drills).
seed "testproj\therdrws\t__ws__\tWS-OLD\ntestproj\therdrws\t__ws__\tWS-NEW\n"
OUT6="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 bash "$ROOT/bin/crew.sh" up codex glm </dev/null 2>&1)"
ok "re-up does NOT create a new workspace" '! echo "$OUT6" | grep -q "workspace create"'
ok "both seats land in the reused workspace" '[ "$(echo "$OUT6" | grep -c "reuse workspace WS-NEW")" = "2" ]'
ok "the older stacked workspace is closed" 'echo "$OUT6" | grep -q "herdr workspace close WS-OLD"'
ok "the reused workspace is NOT closed" '! echo "$OUT6" | grep -q "workspace close WS-NEW"'

# 7. replace-in-place: re-upping a tracked seat replaces ITS pane (split off it, then close it)
seed "testproj\therdrws\t__ws__\tWS-NEW\ntestproj\therdr\tcodex\tTERM-1\n"
OUT7="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 bash "$ROOT/bin/crew.sh" up codex </dev/null 2>&1)"
ok "re-up splits replacing the seat's old pane" 'echo "$OUT7" | grep -q "pane split for codex (replacing TERM-1)"'
ok "the seat's old pane is closed" 'echo "$OUT7" | grep -q "herdr pane close TERM-1"'

# 8. down is PROJECT-SCOPED for herdr rows — teardown reaches herdr regardless of CREW_MUX (you must
#    never need to remember the flag to tear a crew down)
seed "herdrproj\therdrws\t__ws__\tWS-A\nherdrproj\therdr\tcodex\tP-1\nherdrproj\therdr\tglm\tP-2\notherproj\therdrws\t__ws__\tWS-B\notherproj\therdr\tkimi\tP-9\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=herdrproj CREW_NO_PROC_KILL=1 bash "$ROOT/bin/crew.sh" down </dev/null >/dev/null 2>&1
ok "whole-project down closes THIS project's workspace" '[ -f "$TMP/herdr.log" ] && grep -q "herdr workspace close WS-A" "$TMP/herdr.log"'
ok "whole-project down does NOT close another project's workspace" '! grep -q "WS-B" "$TMP/herdr.log"'
ok "this project's rows are gone" '! has_row "herdrproj"'
ok "the other project's rows survive" 'has_row "otherproj	herdr	kimi	P-9" && has_row "otherproj	herdrws	__ws__	WS-B"'

# 9. per-seat down: closes that seat's pane only; the workspace + sibling survive
seed "herdrproj\therdrws\t__ws__\tWS-A\nherdrproj\therdr\tcodex\tP-1\nherdrproj\therdr\tglm\tP-2\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=herdrproj CREW_NO_PROC_KILL=1 bash "$ROOT/bin/crew.sh" down codex </dev/null >/dev/null 2>&1
ok "per-seat down closes that seat's pane" 'grep -q "herdr pane close P-1" "$TMP/herdr.log"'
ok "per-seat down does NOT close the workspace" '! grep -q "workspace close" "$TMP/herdr.log"'
ok "per-seat down keeps the sibling + workspace rows" 'has_row "herdrproj	herdr	glm	P-2" && has_row "herdrproj	herdrws	__ws__	WS-A"'

# 10. down --all --yes reaches herdr rows across projects
seed "herdrproj\therdrws\t__ws__\tWS-A\notherproj\therdrws\t__ws__\tWS-B\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=herdrproj CREW_NO_PROC_KILL=1 bash "$ROOT/bin/crew.sh" down --all --yes </dev/null >/dev/null 2>&1
ok "down --all --yes closes every project's herdr workspace" 'grep -q "herdr workspace close WS-A" "$TMP/herdr.log" && grep -q "herdr workspace close WS-B" "$TMP/herdr.log"'
ok "down --all --yes clears every herdr row" '[ "$(rows)" = "0" ]'

# 11. prune under the opt-in validates herdr rows against LIVE workspace state — workspaces by id,
#     seat rows at WORKSPACE granularity (is a live workspace labeled trantor:<their project> up?),
#     the cmux 0.17.61 lesson generalized: never validate seats per pane.
seed "protest\therdrws\t__ws__\tWS-LIVE\nprotest\therdrws\t__ws__\tWS-DEAD\nprotest\therdr\tglm\tSURF-A\nprotest\therdr\tcodex\tSURF-B\nghostproj\therdr\tkimi\tSURF-C\n"
CREW_MUX=herdr HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=protest HERDR_LIVE_WS='{"workspace_id":"WS-LIVE","label":"trantor:protest"}' bash "$ROOT/bin/crew.sh" prune </dev/null >/dev/null 2>&1
ok "prune keeps the live workspace row" 'has_row "protest	herdrws	__ws__	WS-LIVE"'
ok "prune drops the dead workspace row" '! has_row "WS-DEAD"'
ok "prune keeps EVERY seat row of a live-workspace project" 'has_row "protest	herdr	glm	SURF-A" && has_row "protest	herdr	codex	SURF-B"'
ok "prune drops seat rows of a project with no live workspace" '! has_row "SURF-C"'

# 12. prune WITHOUT the opt-in never touches herdr rows (and never invokes herdr at all)
seed "protest\therdrws\t__ws__\tWS-LIVE\nprotest\therdr\tglm\tSURF-A\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=protest bash "$ROOT/bin/crew.sh" prune </dev/null >/dev/null 2>&1
ok "un-opted prune keeps herdr rows" 'has_row "protest	herdr	glm	SURF-A" && has_row "protest	herdrws	__ws__	WS-LIVE"'
ok "un-opted prune never invokes herdr" 'nolog'

echo ""
if [ "$FAIL" = "0" ]; then echo "ALL PASS ($PASS)"; else echo "$FAIL FAILED"; fi
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
