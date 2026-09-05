import { appleScript, appleScriptString, call, runnerCommand, run, shellQuote } from "./core.mjs";
import { recordState } from "./state.mjs";

export function spawnTmux(ctx, specs, resolve) {
  const session = `trantor:${ctx.project}`;
  let first = !call("tmux", ["has-session", "-t", session], { env: ctx.env }).ok;
  for (const spec of specs) {
    const seat = resolve(spec);
    if (!seat) continue;
    const command = runnerCommand(ctx, seat.agent, seat.model);
    let pane = ctx.dry ? "%DRY" : "";
    if (first) {
      run(ctx, "tmux", ["new-session", "-d", "-s", session, "-n", "crew", "-x", "260", "-y", "60"], { rendered: `tmux new-session -d -s '${session}' -n crew -x 260 -y 60` });
      run(ctx, "tmux", ["send-keys", "-t", session, command, "Enter"], { rendered: `tmux send-keys -t '${session}' ${shellQuote(command)} Enter` });
      first = false;
    } else {
      run(ctx, "tmux", ["split-window", "-t", session, command], { rendered: `tmux split-window -t '${session}' ${shellQuote(command)}` });
      run(ctx, "tmux", ["select-layout", "-t", session, "tiled"], { rendered: `tmux select-layout -t '${session}' tiled >/dev/null 2>&1` });
    }
    if (!ctx.dry) pane = call("tmux", ["display-message", "-p", "-t", session, "#{pane_id}"], { env: ctx.env }).stdout;
    run(ctx, "tmux", ["select-pane", "-t", pane || session, "-T", seat.agent.toUpperCase()], { rendered: `tmux select-pane -t '${pane || session}' -T ${seat.agent.toUpperCase()}` });
    recordState(ctx, ctx.project, "tmux", seat.agent, pane || "%?");
    console.log(`  → ${seat.agent} pane in ${session}`);
  }
  run(ctx, "tmux", ["set-option", "-t", session, "pane-border-status", "top"], { rendered: `tmux set-option -t '${session}' pane-border-status top >/dev/null 2>&1` });
  run(ctx, "tmux", ["set-option", "-t", session, "pane-border-format", " #{pane_title} "], { rendered: `tmux set-option -t '${session}' pane-border-format ' #{pane_title} ' >/dev/null 2>&1` });
  if (ctx.dry) {
    console.log(`[dry] would attach a Terminal window to ${session}`);
    recordState(ctx, ctx.project, "attach", "__win__", "%DRYWIN");
    return;
  }
  const attached = appleScript(`tell application "Terminal"\nset w to do script "tmux attach -t ${appleScriptString(session)}"\nset custom title of w to "${appleScriptString(`${ctx.project} — trantor crew`)}"\nset theWin to first window whose tabs contains w\nreturn id of theWin\nend tell\n`);
  if (attached.stdout) recordState(ctx, ctx.project, "attach", "__win__", attached.stdout);
  console.log(`— crew grouped in tmux session ${session} (one window: ${ctx.project} — trantor crew). Detach with Ctrl-b d; it keeps running. —`);
}

export function spawnTerminal(ctx, specs, resolve) {
  console.log("— no cmux/tmux → per-agent Terminal windows. For ONE grouped, named window per crew (and");
  console.log("  bulletproof scoped teardown), install cmux, or run:  brew install tmux  —");
  const rect = terminalRect(ctx);
  const columns = specs.length <= 2 ? 1 : 2;
  const rows = Math.ceil(specs.length / columns);
  const width = Math.floor(rect.width / columns);
  const height = Math.floor(rect.height / rows);
  for (let index = 0; index < specs.length; index += 1) {
    const seat = resolve(specs[index]);
    if (!seat) continue;
    const x = rect.x + (index % columns) * width;
    const y = rect.y + Math.floor(index / columns) * height;
    if (ctx.dry) {
      console.log(`[dry] Terminal window for ${seat.agent} at ${x},${y}`);
      recordState(ctx, ctx.project, "win", seat.agent, `%DRYWIN${index}`);
      continue;
    }
    const command = `clear && ${runnerCommand(ctx, seat.agent, seat.model)}`;
    const title = `${ctx.project} · ${seat.agent.toUpperCase()}`;
    const result = appleScript(`tell application "Terminal"\nset w to do script "${appleScriptString(command)}"\nset custom title of w to "${appleScriptString(title)}"\nset theWin to first window whose tabs contains w\nset bounds of theWin to {${x}, ${y}, ${x + width}, ${y + height}}\nreturn id of theWin\nend tell\n`);
    if (result.stdout) {
      recordState(ctx, ctx.project, "win", seat.agent, result.stdout);
      console.log(`  → ${seat.agent} window spawned (${ctx.project} · ${seat.agent})`);
    } else console.log(`  ✗ ${seat.agent} osascript spawn ERROR`);
    call("sleep", ["1.2"]);
  }
}

function terminalRect(ctx) {
  if (ctx.env.CREW_RECT) {
    const [x, y, width, height] = ctx.env.CREW_RECT.split(",").map(Number);
    return { x, y, width, height };
  }
  const result = call("osascript", ["-e", 'tell application "Finder" to get bounds of window of desktop']);
  const [left = 0, top = 25, right = 1440, bottom = 900] = result.stdout.split(/,\s*/).map(Number);
  const screenWidth = right - left;
  return { x: left + Math.floor(screenWidth * 0.42), y: top || 25, width: Math.floor(screenWidth * 0.58), height: bottom - (top || 25) };
}
