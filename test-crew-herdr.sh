#!/bin/bash
# herdr mux tests (card #5345, P0-B): CREW_MUX=herdr is an EXPLICIT opt-in — herdr is never
# auto-detected, and every other mux path (cmux/tmux/terminal) stays untouched. herdr is not
# installed on this machine, so every drill runs the REAL crew.sh against a temp HOME with a STUB
# herdr (counter-unique JSON ids, exactly the capture-don't-predict contract of the real CLI).
# The osascript stub CATS STDIN — every crew.sh invocation here carries </dev/null (hung-suite
# lesson, 2026-08-20).
set -u
# Same as test-crew.sh (#6228 bounce, 8c82e8e): the suite must not inherit the RUNNER's own identity
# badge, or every dry spawn for testproj is refused by the cross-project guard as a badge mismatch.
unset TRANTOR_ORCH TRANTOR_SEAT HERDR_ENV HERDR_PANE_ID RELAY_PROJECT RELAY_SESSION RELAY_AGENT TRANTOR_PROJECT
ROOT="$(cd "$(dirname "$0")" && pwd)"
CREW=("$(command -v node)" "$ROOT/bin/crew.mjs")
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
# A dry run of a real provider seat still needs that provider catalog: resolve_model falls back
# to the catalog head when no router answers (#6110) and refuses the opencode global default (#6068).
cat > "$TMP/fakebin/opencode" <<EOF
case "\$1 \$2" in
  "models zai-coding-plan") echo zai-coding-plan/glm-5.3-flash ;;
  "models qwen") echo qwen/qwen3.8-max ;;
  "models "*) echo "\$2/catalog-head" ;;
esac
exit 0
EOF
chmod +x "$TMP/fakebin/opencode"
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
    rename) case "\$3" in P-DEAD) exit 1 ;; esac ;;   # a pane id that answers rename = alive (open's probe)
    list)   printf '{"result":{"panes":[%s]}}' "\${HERDR_LIVE_PANES:-}" ;;   # replays \$HERDR_LIVE_PANES (open's host pick)
    report-agent) echo "\$3" >> "$TMP/herdr.agents" ;;   # a pane herdr now considers an agent
  esac ;;
  # Only panes that were REPORTED are agents. That is the real asymmetry: a pane can answer rename
  # while nothing runs inside it, which is what open's liveness probe has to catch.
  agent) case "\$2" in
    list) printf '{"result":{"agents":['
          if [ -f "$TMP/herdr.agents" ]; then
            sep=""
            while read -r pid; do [ -n "\$pid" ] || continue; printf '%s{"pane_id":"%s"}' "\$sep" "\$pid"; sep=","; done < "$TMP/herdr.agents"
          fi
          printf ']}}' ;;
  esac ;;
esac
exit 0
EOF
chmod +x "$TMP/fakebin/"*
# a PATH with NO herdr at all (opt-in-without-binary + cmux-default drills). The cmux stub is
# deliberate: have.cmux also checks /Applications/cmux.app (core.mjs), which exists on a dev Mac
# but not on the CI runner — without the stub the default dispatch lands on the tmux stub there
# and the "old cmux default" drill goes red runner-only (run 33992833649).
mkdir -p "$TMP/fakebin_noherdr"; cp "$TMP/fakebin/osascript" "$TMP/fakebin/tmux" "$TMP/fakebin/cmux" "$TMP/fakebin_noherdr/"
STATE="$TMP/.agent-bus/crew-windows.txt"
seed(){ printf '%b' "$1" > "$STATE"; }
rows(){ [ -f "$STATE" ] && wc -l < "$STATE" | tr -d ' ' || echo 0; }
has_row(){ [ -f "$STATE" ] && grep -qF "$1" "$STATE"; }
nolog(){ [ ! -f "$TMP/herdr.log" ] || ! grep -q . "$TMP/herdr.log"; }

echo "# herdr mux tests (CREW_MUX=herdr explicit opt-in)"

# 1. opting in WITHOUT the binary → hard error + install hint; nothing spawned, nothing recorded
if (cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin_noherdr:/usr/bin:/bin" RELAY_PROJECT=testproj CREW_MUX=herdr "${CREW[@]}" up codex </dev/null >/dev/null 2>&1); then rc=0; else rc=1; fi
ok "CREW_MUX=herdr without herdr installed is a HARD error" '[ "$rc" = "1" ]'
OUT1="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin_noherdr:/usr/bin:/bin" RELAY_PROJECT=testproj CREW_MUX=herdr "${CREW[@]}" up codex </dev/null 2>&1)"
ok "the error says how to install herdr (user-local, no sudo)" 'echo "$OUT1" | grep -q "herdr is not installed"'
ok "failed opt-in records no state" '[ "$(rows)" = "0" ]'

# 2. opt-in ONLY: herdr on PATH but CREW_MUX unset → the default dispatch never invokes herdr
OUT2="$(cd "$TMP/proj" && CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 "${CREW[@]}" up codex </dev/null 2>&1)"
# CONTRACT CHANGE (0.18.10): herdr is auto-preferred when its binary is present — it is the only
# backend the app's Workspace pane can render, and the opt-in default left every other project's
# crew invisible. With the stub herdr on PATH the un-opted default now selects herdr; forcing
# CREW_MUX=cmux restores the old dispatch; a PATH without herdr falls back to cmux on its own.
ok "default dispatch prefers herdr when the binary is present" 'echo "$OUT2" | grep -q "herdr"'
OUT2b="$(cd "$TMP/proj" && CREW_MUX=cmux CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 "${CREW[@]}" up codex </dev/null 2>&1)"
ok "CREW_MUX=cmux still forces the old dispatch" 'echo "$OUT2b" | grep -q "seats tiled + sidebar status"'
OUT2c="$(cd "$TMP/proj" && CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin_noherdr:/usr/bin:/bin" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 "${CREW[@]}" up codex </dev/null 2>&1)"
# Assert only that we landed on the cmux path without erroring. Which cmux integration answers is
# not this drill's business: the stub answers ping, so the socket-control path prints "seats tiled
# + sidebar status"; a machine without the stub's answer would print the AppleScript wording. Both
# carry "grouped in cmux" + "seats tiled" — pinning either wording made this red on main.
ok "no herdr on PATH -> the old cmux default, no error" 'echo "$OUT2c" | grep -q "grouped in cmux" && echo "$OUT2c" | grep -q "seats tiled"'

# 3. the tmux path is untouched by herdr's presence
rm -f "$TMP/herdr.log" "$TMP/tmux.log"
OUT3="$(cd "$TMP/proj" && CREW_MUX=tmux CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 "${CREW[@]}" up codex glm </dev/null 2>&1)"
ok "tmux path still groups into the project session" 'echo "$OUT3" | grep -q "tmux new-session -d -s .trantor:testproj"'
ok "tmux path never invokes herdr" 'nolog'

# 4. CREW_MUX=herdr dry spawn: ONE workspace, root pane runs seat 1, RIGHT split for seat 2
rm -f "$TMP/herdr.log"
OUT4="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj CREW_HUB=http://10.7.7.7:4477 "${CREW[@]}" up codex glm </dev/null 2>&1)"
ok "announces the herdr grouping UI" 'echo "$OUT4" | grep -q "bringing up crew for testproj (herdr)"'
ok "creates ONE workspace labeled trantor:<project>" 'echo "$OUT4" | grep -q "herdr: workspace create (cwd" && echo "$OUT4" | grep -q "trantor:testproj"'
ok "seat 2 arrives via a RIGHT split off seat 1" 'echo "$OUT4" | grep -q "pane split %DRYT0 --direction right"'
ok "two seats spawned" '[ "$(echo "$OUT4" | grep -c "seat in herdr workspace")" = "2" ]'
# Without report-agent the pane is only a shell to herdr, `herdr agent attach` answers
# agent_not_found, and the app renders that error where the seat should be.
ok "each seat is reported to herdr as an agent (pane id FIRST, then flags)" 'echo "$OUT4" | grep -q "report-agent %DRYT0 --source crew --agent codex --state working"'
ok "the runner command rides pane run, hub binding baked in" 'echo "$OUT4" | grep -q "crew-runner\.mjs codex" && echo "$OUT4" | grep -q "RELAY_URL=http://10.7.7.7:4477"'
ok "herdr spawn summary names the workspace + scoped teardown" 'echo "$OUT4" | grep -q "crew grouped in herdr"'
ok "dry spawn does no bus verify" 'echo "$OUT4" | grep -q "dry run: no bus verify"'

# 5. grid tiling for 4 seats — same ceil(√N) doctrine as cmux: row 0 RIGHT, later rows DOWN
OUT5="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 "${CREW[@]}" up codex glm deepseek kimi </dev/null 2>&1)"
ok "4-seat grid: seat 2 splits RIGHT from seat 1" 'echo "$OUT5" | grep -q "pane split %DRYT0 --direction right"'
ok "4-seat grid: seat 3 splits DOWN from seat 1" 'echo "$OUT5" | grep -q "pane split %DRYT0 --direction down"'
ok "4-seat grid: seat 4 splits DOWN from seat 2" 'echo "$OUT5" | grep -q "pane split %DRYT1 --direction down"'

# 6. replace-never-stack: a second up REUSES the newest tracked workspace; older stacks are closed.
#    Dry mode reads STATE read-only, so the board can be seeded (same contract as the cmux drills).
seed "testproj\therdrws\t__ws__\tWS-OLD\ntestproj\therdrws\t__ws__\tWS-NEW\n"
OUT6="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 "${CREW[@]}" up codex glm </dev/null 2>&1)"
ok "re-up does NOT create a new workspace" '! echo "$OUT6" | grep -q "workspace create"'
ok "both seats land in the reused workspace" '[ "$(echo "$OUT6" | grep -c "reuse workspace WS-NEW")" = "2" ]'
ok "the older stacked workspace is closed" 'echo "$OUT6" | grep -q "herdr workspace close WS-OLD"'
ok "the reused workspace is NOT closed" '! echo "$OUT6" | grep -q "workspace close WS-NEW"'

# 7. replace-in-place: re-upping a tracked seat replaces ITS pane (split off it, then close it)
seed "testproj\therdrws\t__ws__\tWS-NEW\ntestproj\therdr\tcodex\tTERM-1\n"
OUT7="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj RELAY_URL=http://127.0.0.1:1111 "${CREW[@]}" up codex </dev/null 2>&1)"
ok "re-up splits replacing the seat's old pane" 'echo "$OUT7" | grep -q "pane split for codex (replacing TERM-1)"'
ok "the seat's old pane is closed" 'echo "$OUT7" | grep -q "herdr pane close TERM-1"'

# 8. down is PROJECT-SCOPED for herdr rows — teardown reaches herdr regardless of CREW_MUX (you must
#    never need to remember the flag to tear a crew down)
seed "herdrproj\therdrws\t__ws__\tWS-A\nherdrproj\therdr\tcodex\tP-1\nherdrproj\therdr\tglm\tP-2\notherproj\therdrws\t__ws__\tWS-B\notherproj\therdr\tkimi\tP-9\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=herdrproj CREW_NO_PROC_KILL=1 "${CREW[@]}" down </dev/null >/dev/null 2>&1
ok "whole-project down closes THIS project's workspace" '[ -f "$TMP/herdr.log" ] && grep -q "herdr workspace close WS-A" "$TMP/herdr.log"'
ok "whole-project down does NOT close another project's workspace" '! grep -q "WS-B" "$TMP/herdr.log"'
ok "this project's rows are gone" '! has_row "herdrproj"'
ok "the other project's rows survive" 'has_row "otherproj	herdr	kimi	P-9" && has_row "otherproj	herdrws	__ws__	WS-B"'

# 9. per-seat down: closes that seat's pane only; the workspace + sibling survive
seed "herdrproj\therdrws\t__ws__\tWS-A\nherdrproj\therdr\tcodex\tP-1\nherdrproj\therdr\tglm\tP-2\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=herdrproj CREW_NO_PROC_KILL=1 "${CREW[@]}" down codex </dev/null >/dev/null 2>&1
ok "per-seat down closes that seat's pane" 'grep -q "herdr pane close P-1" "$TMP/herdr.log"'
ok "per-seat down does NOT close the workspace" '! grep -q "workspace close" "$TMP/herdr.log"'
ok "per-seat down keeps the sibling + workspace rows" 'has_row "herdrproj	herdr	glm	P-2" && has_row "herdrproj	herdrws	__ws__	WS-A"'

# 10. down --all --yes reaches herdr rows across projects
seed "herdrproj\therdrws\t__ws__\tWS-A\notherproj\therdrws\t__ws__\tWS-B\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=herdrproj CREW_NO_PROC_KILL=1 "${CREW[@]}" down --all --yes </dev/null >/dev/null 2>&1
ok "down --all --yes closes every project's herdr workspace" 'grep -q "herdr workspace close WS-A" "$TMP/herdr.log" && grep -q "herdr workspace close WS-B" "$TMP/herdr.log"'
ok "down --all --yes clears every herdr row" '[ "$(rows)" = "0" ]'

# 11. prune under the opt-in validates herdr rows against LIVE workspace state — workspaces by id,
#     seat rows at WORKSPACE granularity (is a live workspace labeled trantor:<their project> up?),
#     the cmux 0.17.61 lesson generalized: never validate seats per pane.
seed "protest\therdrws\t__ws__\tWS-LIVE\nprotest\therdrws\t__ws__\tWS-DEAD\nprotest\therdr\tglm\tSURF-A\nprotest\therdr\tcodex\tSURF-B\nghostproj\therdr\tkimi\tSURF-C\n"
CREW_MUX=herdr HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=protest HERDR_LIVE_WS='{"workspace_id":"WS-LIVE","label":"trantor:protest"}' "${CREW[@]}" prune </dev/null >/dev/null 2>&1
ok "prune keeps the live workspace row" 'has_row "protest	herdrws	__ws__	WS-LIVE"'
ok "prune drops the dead workspace row" '! has_row "WS-DEAD"'
ok "prune keeps EVERY seat row of a live-workspace project" 'has_row "protest	herdr	glm	SURF-A" && has_row "protest	herdr	codex	SURF-B"'
ok "prune drops seat rows of a project with no live workspace" '! has_row "SURF-C"'

# 12. prune with NO herdr on PATH preserves herdr rows and cannot invoke the binary — the row-
# preservation invariant survives the auto-preference change; only the "never consults herdr while
# it is installed" claim died with the opt-in contract.
seed "protest\therdrws\t__ws__\tWS-LIVE\nprotest\therdr\tglm\tSURF-A\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin_noherdr:/usr/bin:/bin" RELAY_PROJECT=protest "${CREW[@]}" prune </dev/null >/dev/null 2>&1
ok "herdr-less prune keeps herdr rows" 'has_row "protest	herdr	glm	SURF-A" && has_row "protest	herdrws	__ws__	WS-LIVE"'
ok "herdr-less prune never invokes herdr" 'nolog'

# 12b. the split helper's optional cwd stays optional on the Node path. Import the helper directly;
#      the existing herdr stub records the exact argv and returns the same parsed pane id.
split_drill() {
  rm -f "$TMP/split.log"
  SPLIT_LOG="$TMP/split.log" "${CREW[0]}" --input-type=module -e '
    import { appendFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const mod = await import(pathToFileURL(process.argv[1]));
    const [pane, direction, cwd = ""] = process.argv.slice(2);
    const invoke = (_ctx, args) => {
      appendFileSync(process.env.SPLIT_LOG, `herdr ${args.join(" ")}\n`);
      return { stdout: `{"result":{"pane":{"pane_id":"P-SPLIT"}}}` };
    };
    process.stdout.write(mod.splitPane({ env: process.env }, pane, direction, cwd, invoke));
  ' "$ROOT/bin/crew/herdr.mjs" "$@"
}
OUT12b="$(LOG="$TMP/split.log" split_drill P-1 right 2>&1)"; rc12b=$?
ok "a two-argument split (seat spawn) survives set -u" '[ "$rc12b" = "0" ] && [ "$OUT12b" = "P-SPLIT" ]'
ok "…and asks herdr for a plain split, no --cwd" 'grep -q "^herdr pane split P-1 --direction right --no-focus$" "$TMP/split.log"'
OUT12c="$(LOG="$TMP/split.log" split_drill P-1 right /some/dir 2>&1)"
ok "a three-argument split carries --cwd" '[ "$OUT12c" = "P-SPLIT" ] && grep -q -- "--direction right --no-focus --cwd /some/dir$" "$TMP/split.log"'

# 13. `trantor open` (card #5396, W3-A): hosts the OPERATOR's claude as the `orchestrator · <project>`
#     pane in the crew workspace and prints its TARGET on stdout as ONE line. Dry mode: [dry] lines
#     + %DRY ids, exactly like the dry spawn drills.
seed ""
rc13=0
OUT13="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj "${CREW[@]}" open </dev/null 2>/dev/null)" || rc13=$?
ok "open exits 0" '[ "$rc13" = "0" ]'
ok "open prints the target as ONE stdout line" '[ "$(printf "%s\n" "$OUT13" | wc -l | tr -d " ")" = "1" ] && echo "$OUT13" | grep -q "^herdr:%DRYWS/%DRYORCH$"'
# A dry open must not touch STATE: record_state/_state_drop are no-ops under CREW_DRY_RUN, the
# same contract "failed opt-in records no state" and "herdr-less open records no state" rely on.
# Row recording is asserted for real against the herdr stub in drill 16.
ok "a dry open writes NO state" '[ "$(rows)" = "0" ]'

# 14. reattach, never stack: a second open prints the SAME target and spawns nothing new
OUT14="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj "${CREW[@]}" open </dev/null 2>/dev/null)"
ok "second open reattaches to the SAME target (exit 0)" '[ "$OUT14" = "$OUT13" ]'
# reattach-never-stack is asserted for real in drill 16 ("still exactly one orch row" plus the
# no-second-create pair). Dry mode writes no rows, so it cannot show stacking either way.
ok "a second dry open still writes NO state" '[ "$(rows)" = "0" ]'

# 15. open without herdr installed is a hard error (the pane host is not optional), recording nothing
seed ""
OUT15="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin_noherdr:/usr/bin:/bin" RELAY_PROJECT=testproj "${CREW[@]}" open </dev/null 2>&1)"; rc15=$?
ok "herdr-less open is a HARD error" '[ "$rc15" = "1" ] && echo "$OUT15" | grep -q "needs herdr"'
ok "herdr-less open records no state" '[ "$(rows)" = "0" ]'

# 16. open for real (stub): fresh workspace whose ROOT pane runs claude in the project dir
echo 0 > "$TMP/herdr.n"; rm -f "$TMP/herdr.log"; seed ""
OUT16="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj CREW_NO_PROC_KILL=1 "${CREW[@]}" open </dev/null 2>/dev/null)"
ok "real open creates the crew workspace and prints its target" '[ "$OUT16" = "herdr:WS-1/P-1" ]'
ok "the orchestrator pane runs claude via pane run" 'grep -qE "herdr pane run P-1 env .* claude" "$TMP/herdr.log"'
ok "the workspace is created in the project dir" 'grep -q "workspace create --cwd $TMP/proj --label trantor:testproj" "$TMP/herdr.log"'
ok "real open records the orch row" 'has_row "testproj	orch	__orch__	P-1"'
# ...and a second REAL open reattaches: no second create, no second claude
rm -f "$TMP/herdr.log"
OUT16b="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj CREW_NO_PROC_KILL=1 "${CREW[@]}" open </dev/null 2>/dev/null)"
ok "second real open reattaches (same target, exit 0)" '[ "$OUT16b" = "herdr:WS-1/P-1" ]'
ok "second real open creates NO second workspace" '! grep -q "workspace create" "$TMP/herdr.log" 2>/dev/null'
ok "second real open runs NO second claude" '! grep -q "pane run" "$TMP/herdr.log" 2>/dev/null'
ok "still exactly one orch row" '[ "$(grep -c "	orch	" "$STATE")" = "1" ]'

# 17. reattach heals a STALE orch row: the tracked pane no longer answers rename → new pane, new row
echo 0 > "$TMP/herdr.n"; rm -f "$TMP/herdr.log"
seed "testproj	herdrws	__ws__	WS-9\ntestproj	orch	__orch__	P-DEAD\n"
# The host of that split is a pane INSIDE WS-9 (the project's own workspace), in the project dir —
# never the UI-focused pane, which lives wherever the operator is looking (2026-09-03: crebral-com's
# orchestrator opened in the trantor window twice, as a trantor twin). The focused pane here is foreign.
PANES17='{"pane_id":"P-FOCUS","workspace_id":"WS-OTHER","cwd":"/elsewhere","focused":true},{"pane_id":"P-HOST","workspace_id":"WS-9","cwd":"'"$TMP/proj"'"}'
OUT17="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj HERDR_LIVE_WS='{"workspace_id":"WS-9","label":"trantor:testproj"}' HERDR_LIVE_PANES="$PANES17" CREW_NO_PROC_KILL=1 "${CREW[@]}" open </dev/null 2>/dev/null)"
ok "stale orch pane is healed onto a fresh split (no re-stack of the dead one)" '[ "$OUT17" = "herdr:WS-9/P-1" ]'
ok "the healed pane runs claude" 'grep -qE "herdr pane run P-1 env .* claude" "$TMP/herdr.log"'
ok "the split is hosted off a pane of the PROJECT workspace, in the project dir" 'grep -q "herdr pane split P-HOST --direction right --no-focus --cwd $TMP/proj" "$TMP/herdr.log"'
ok "the split never targets the UI-focused pane of another workspace" '! grep -qE "herdr pane split (P-FOCUS|--direction)" "$TMP/herdr.log"'
ok "the stale orch row is replaced, not duplicated" 'has_row "testproj	orch	__orch__	P-1" && ! has_row "P-DEAD"'
# ...and with NO live pane in the workspace, open refuses rather than guessing a host
echo 0 > "$TMP/herdr.n"; rm -f "$TMP/herdr.log"
seed "testproj	herdrws	__ws__	WS-9\ntestproj	orch	__orch__	P-DEAD\n"
OUT17b="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj HERDR_LIVE_WS='{"workspace_id":"WS-9","label":"trantor:testproj"}' HERDR_LIVE_PANES='{"pane_id":"P-FOCUS","workspace_id":"WS-OTHER","cwd":"/elsewhere","focused":true}' CREW_NO_PROC_KILL=1 "${CREW[@]}" open </dev/null 2>&1)"; rc17b=$?
ok "a workspace with no live pane is a hard error, not a split off a foreign pane" '[ "$rc17b" = "1" ] && echo "$OUT17b" | grep -q "no live pane to host"'
ok "the live tracked workspace was reused, not recreated" '! grep -q "workspace create" "$TMP/herdr.log"'

# 18. down SPARES the orch row: whole-project teardown closes seat panes only — the workspace (and
#     the operator's terminal inside it) survives, so a down typed INSIDE the orchestrator pane
#     cannot close the pane it was typed into.
seed "herdrproj	herdrws	__ws__	WS-A\nherdrproj	herdr	codex	P-1\nherdrproj	herdr	glm	P-2\nherdrproj	orch	__orch__	P-ORCH\notherproj	herdrws	__ws__	WS-B\notherproj	herdr	kimi	P-9\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=herdrproj CREW_NO_PROC_KILL=1 "${CREW[@]}" down </dev/null >/dev/null 2>&1
ok "orch-hosted down closes THIS project's seat panes" 'grep -q "herdr pane close P-1" "$TMP/herdr.log" && grep -q "herdr pane close P-2" "$TMP/herdr.log"'
ok "orch-hosted down does NOT close the workspace" '! grep -q "workspace close" "$TMP/herdr.log"'
ok "orch-hosted down does NOT touch another project" '! grep -q "WS-B" "$TMP/herdr.log" && ! grep -q "P-9" "$TMP/herdr.log"'
ok "the orch row survives the teardown" 'has_row "herdrproj	orch	__orch__	P-ORCH"'
ok "the workspace row survives with it" 'has_row "herdrproj	herdrws	__ws__	WS-A"'
ok "the torn-down seats lose their rows" '! has_row "herdrproj	herdr	codex" && ! has_row "herdrproj	herdr	glm"'

# 19. down --all --yes also spares orch rows (uniform rule: never kill the operator's session)
seed "herdrproj	herdrws	__ws__	WS-A\nherdrproj	orch	__orch__	P-ORCH\notherproj	herdrws	__ws__	WS-B\notherproj	herdr	kimi	P-9\n"
rm -f "$TMP/herdr.log"
HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=herdrproj CREW_NO_PROC_KILL=1 "${CREW[@]}" down --all --yes </dev/null >/dev/null 2>&1
ok "down --all --yes closes orch-less workspaces" 'grep -q "herdr workspace close WS-B" "$TMP/herdr.log"'
ok "down --all --yes spares the orch-hosting workspace" '! grep -q "workspace close WS-A" "$TMP/herdr.log"'
ok "down --all --yes leaves orch-less seats to their workspace close (no stray per-pane call)" '! grep -q "pane close P-9" "$TMP/herdr.log"'
ok "down --all --yes keeps the orch + its workspace rows" 'has_row "herdrproj	orch	__orch__	P-ORCH" && has_row "herdrproj	herdrws	__ws__	WS-A"'

# 20. prune validates orch rows at WORKSPACE granularity — same keep-when-unprovable doctrine as
#     seat rows: live while their project's crew workspace lives, dropped with it
seed "protest	herdrws	__ws__	WS-LIVE\nprotest	orch	__orch__	P-LIVE\nghostproj	orch	__orch__	P-GHOST\n"
CREW_MUX=herdr HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=protest HERDR_LIVE_WS='{"workspace_id":"WS-LIVE","label":"trantor:protest"}' "${CREW[@]}" prune </dev/null >/dev/null 2>&1
ok "prune keeps the orch row of a live-workspace project" 'has_row "protest	orch	__orch__	P-LIVE"'
ok "prune drops the orch row of a dead project" '! has_row "P-GHOST"'

# 19. persistence (card #5401). herdr keeps the PANE across an app quit and launchd keeps its
#     server across a reboot, but neither keeps the CONVERSATION — a pty that dies comes back
#     empty. So the project owns one claude session id and `open` resumes it.
echo ""
echo "The pane can die; the conversation should not:"
echo 0 > "$TMP/herdr.n"; rm -f "$TMP/herdr.log" "$TMP/herdr.agents"; seed ""
OUT19="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj CREW_NO_PROC_KILL=1 "${CREW[@]}" open </dev/null 2>/dev/null)"
ok "a first open starts claude under an id WE chose" 'grep -qE "pane run P-1 env .* claude --session-id [0-9a-f-]{36}" "$TMP/herdr.log"'
# A herdr server started from inside a Claude session poisons every pane it spawns: the child
# marker turns transcript saving OFF, so --resume would have nothing to resume, and the
# messaging socket points the new session at the originating one's baton.
ok "the inherited child-session marker is stripped" 'grep -q "pane run P-1 env .*-u CLAUDE_CODE_CHILD_SESSION" "$TMP/herdr.log"'
ok "…and so is the socket that would steal another session's baton" 'grep -q "pane run P-1 env .*-u CLAUDE_CODE_MESSAGING_SOCKET" "$TMP/herdr.log"'
ok "the id is recorded against the project" 'grep -q "^testproj	" "$TMP/.agent-bus/orch-sessions.txt" 2>/dev/null'
SID19="$(cut -f2 < "$TMP/.agent-bus/orch-sessions.txt" 2>/dev/null | head -1)"
ok "the recorded id is the one claude was given" 'grep -q "claude --session-id $SID19" "$TMP/herdr.log"'

# the pane outlives its claude: herdr still answers rename, but nothing is running in it
rm -f "$TMP/herdr.log" "$TMP/herdr.agents"
SLUG19="$(printf '%s' "$TMP/proj" | tr '/.' '--')"
mkdir -p "$TMP/.claude/projects/$SLUG19"; : > "$TMP/.claude/projects/$SLUG19/$SID19.jsonl"
OUT19b="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj CREW_NO_PROC_KILL=1 "${CREW[@]}" open </dev/null 2>/dev/null)"
ok "an empty pane is refilled by RESUMING the conversation" 'grep -q "pane run P-1 env .* claude --resume $SID19" "$TMP/herdr.log"'
ok "…in the same pane, with no second workspace" '! grep -q "workspace create" "$TMP/herdr.log"'
ok "…and the project still has exactly one orch row" '[ "$(grep -c "	orch	" "$STATE")" = "1" ]'
ok "…and it mints no second session id" '[ "$(wc -l < "$TMP/.agent-bus/orch-sessions.txt")" -eq 1 ]'
ok "the reattach still prints the same target" '[ "$OUT19b" = "$OUT19" ]'

# a pane that IS running claude must be left strictly alone
rm -f "$TMP/herdr.log"; echo "P-1" > "$TMP/herdr.agents"
OUT19c="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj CREW_NO_PROC_KILL=1 "${CREW[@]}" open </dev/null 2>/dev/null)"
ok "a LIVE orchestrator is reattached, never restarted" '! grep -q "pane run" "$TMP/herdr.log"'
ok "…and still reports the same target" '[ "$OUT19c" = "$OUT19" ]'

# 20. the HARNESS dial reaches the pane. A setting nobody can observe is not a setting, and this
#     one decides whether the operator's own session skips permission prompts.
echo ""
echo "The harness dial decides what claude the pane runs:"
echo 0 > "$TMP/herdr.n"; rm -f "$TMP/herdr.log" "$TMP/herdr.agents"; seed ""
OUT20="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj "${CREW[@]}" open </dev/null 2>&1)"
ok "a fresh install does NOT skip permissions" '! echo "$OUT20" | grep -q "dangerously-skip-permissions"'
printf '{"defaults":{"harness":"bypass"}}' > "$TMP/.agent-bus/autonomy.json"
OUT20b="$(cd "$TMP/proj" && CREW_MUX=herdr CREW_DRY_RUN=1 HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj "${CREW[@]}" open </dev/null 2>&1)"
ok "turning the dial to bypass reaches the pane's command" 'echo "$OUT20b" | grep -q "claude --dangerously-skip-permissions"'
rm -f "$TMP/.agent-bus/autonomy.json"

# 21. a recorded thread that HANDED OFF is not resumed. Its conversation ended in a handoff that
#     waits for a successor; resuming the dead id replays the wrong thread (2026-08-27 seam). Open
#     must start a FRESH id so the sessionstart hook can claim the baton and re-record the map.
echo ""
echo "A handed-off thread is not resumed:"
echo 0 > "$TMP/herdr.n"; rm -f "$TMP/herdr.log" "$TMP/herdr.agents"; seed ""
printf 'testproj\tDEAD-SID\n' > "$TMP/.agent-bus/orch-sessions.txt"
mkdir -p "$TMP/.claude/projects/$SLUG19"; : > "$TMP/.claude/projects/$SLUG19/DEAD-SID.jsonl"
mkdir -p "$TMP/.agent-bus/handoffs"
printf '{"id":"testproj-1700000000","projectName":"testproj","session_id":"DEAD-SID","stamp":1700000000,"consumed":false}' > "$TMP/.agent-bus/handoffs/testproj-1700000000.json"
OUT21="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj CREW_NO_PROC_KILL=1 "${CREW[@]}" open </dev/null 2>/dev/null)"
ok "open does NOT resume the handed-off thread" '! grep -q "claude --resume DEAD-SID" "$TMP/herdr.log"'
ok "open starts a FRESH session id instead" 'grep -qE "claude --session-id [0-9a-f-]{36}" "$TMP/herdr.log"'
ok "the pane command carries the orchestrator badge" 'grep -q "TRANTOR_ORCH=testproj claude" "$TMP/herdr.log"'
ok "open itself does not rewrite the map (the hook is the writer)" 'grep -q "^testproj	DEAD-SID$" "$TMP/.agent-bus/orch-sessions.txt"'
# once the handoff is CONSUMED, the recorded thread is live again — resume as before
printf '{"id":"testproj-1700000000","projectName":"testproj","session_id":"DEAD-SID","stamp":1700000000,"consumed":true}' > "$TMP/.agent-bus/handoffs/testproj-1700000000.json"
echo 0 > "$TMP/herdr.n"; rm -f "$TMP/herdr.log" "$TMP/herdr.agents"; seed ""
OUT21b="$(cd "$TMP/proj" && HOME="$TMP" PATH="$TMP/fakebin:$PATH" RELAY_PROJECT=testproj CREW_NO_PROC_KILL=1 "${CREW[@]}" open </dev/null 2>/dev/null)"
ok "a CONSUMED handoff does not block resuming" 'grep -q "claude --resume DEAD-SID" "$TMP/herdr.log"'
rm -f "$TMP/.agent-bus/handoffs/testproj-1700000000.json"

# 22. `open A` from project B must not silently relocate and host A while the launching shell still
#     belongs to B. The 09-03 incident produced two orchestrators on one main this way: the explicit
#     argument and the inherited cwd/badge disagreed, and open trusted the argument alone.
echo ""
echo "A crossed cwd or pane badge cannot host another project's orchestrator:"
mkdir -p "$TMP/project-a" "$TMP/project-b" "$TMP/neutral"
git init -q "$TMP/project-a"
git init -q "$TMP/project-b"
rm -f "$TMP/herdr.log"; seed ""
OUT22="$(cd "$TMP/project-b" && HOME="$TMP" TRANTOR_DEV_ROOT="$TMP" PATH="$TMP/fakebin:$PATH" "${CREW[@]}" open project-a </dev/null 2>&1)"; rc22=$?
ok "open A from project B's cwd is a hard refusal" '[ "$rc22" = "1" ] && echo "$OUT22" | grep -q "cwd belongs to project .project-b., not .project-a."'
ok "the cwd refusal happens before herdr can host anything" 'nolog && [ "$(rows)" = "0" ]'
OUT22b="$(cd "$TMP/neutral" && HOME="$TMP" TRANTOR_DEV_ROOT="$TMP" TRANTOR_ORCH=project-b PATH="$TMP/fakebin:$PATH" "${CREW[@]}" open project-a </dev/null 2>&1)"; rc22b=$?
ok "open A from a pane badged B is a hard refusal" '[ "$rc22b" = "1" ] && echo "$OUT22b" | grep -q "badged for .project-b., not .project-a."'
ok "the badge refusal names the safe next action" 'echo "$OUT22b" | grep -q "target project.s shell"'

echo ""
if [ "$FAIL" = "0" ]; then echo "ALL PASS ($PASS)"; else echo "$FAIL FAILED"; fi
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
