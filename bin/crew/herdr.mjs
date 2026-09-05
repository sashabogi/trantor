import { call, gridColumns, parseJsonOutput, runnerCommand } from "./core.mjs";
import { dropState, readRows, recordState } from "./state.mjs";

export function herdrCall(ctx, args) {
  return call("herdr", args, { env: ctx.env });
}

export function workspaceList(ctx) {
  if (!ctx.have.herdr) return { proven: false, ids: new Set(), names: new Set(), items: [] };
  const result = herdrCall(ctx, ["workspace", "list"]);
  const parsed = parseJsonOutput(result.stdout);
  if (!result.ok || !parsed) return { proven: false, ids: new Set(), names: new Set(), items: [] };
  const items = Array.isArray(parsed) ? parsed : parsed.workspaces || parsed.result?.workspaces || [];
  return {
    proven: items.length > 0,
    ids: new Set(items.map(item => item.workspace_id || item.id).filter(Boolean)),
    names: new Set(items.map(item => item.label || item.name || item.custom_title).filter(Boolean)),
    items,
  };
}

export function createWorkspace(ctx, cwd, label) {
  const parsed = parseJsonOutput(herdrCall(ctx, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]).stdout);
  const result = parsed?.result || {};
  return {
    workspace: result.workspace?.workspace_id || "",
    pane: result.root_pane?.pane_id || "",
  };
}

export function splitPane(ctx, pane, direction, cwd = "", execute = herdrCall) {
  const args = ["pane", "split"];
  if (pane) args.push(pane);
  args.push("--direction", direction, "--no-focus");
  if (cwd) args.push("--cwd", cwd);
  const parsed = parseJsonOutput(execute(ctx, args).stdout);
  return parsed?.result?.pane?.pane_id || "";
}

export function workspacePane(ctx, workspace, preferredCwd) {
  const parsed = parseJsonOutput(herdrCall(ctx, ["pane", "list"]).stdout);
  const panes = Array.isArray(parsed) ? parsed : parsed?.panes || parsed?.result?.panes || [];
  const matches = panes.filter(pane => (pane.workspace_id || pane.workspace || "") === workspace);
  return matches.find(pane => (pane.cwd || "") === preferredCwd)?.pane_id || matches[0]?.pane_id || matches[0]?.id || "";
}

export function closeWorkspace(ctx, id) {
  if (ctx.dry) { console.log(`[dry] herdr workspace close ${id}`); return; }
  herdrCall(ctx, ["workspace", "close", id]);
}

export function closePane(ctx, id) {
  if (ctx.dry) { console.log(`[dry] herdr pane close ${id}`); return; }
  herdrCall(ctx, ["pane", "close", id]);
}

export function reportAgent(ctx, pane, agent) {
  if (!pane) return;
  if (ctx.dry) {
    console.log(`[dry] herdr pane report-agent ${pane} --source crew --agent ${agent} --state working`);
    return;
  }
  herdrCall(ctx, ["pane", "report-agent", pane, "--source", "crew", "--agent", agent, "--state", "working"]);
}

function runSeat(ctx, pane, agent, command) {
  if (!pane || ctx.dry) return;
  herdrCall(ctx, ["pane", "rename", pane, `${agent} · ${ctx.project}`]);
  herdrCall(ctx, ["pane", "run", pane, command]);
}

function trackedWorkspace(ctx) {
  const ids = readRows(ctx).filter(row => row.project === ctx.project && row.kind === "herdrws").map(row => row.handle);
  return { reuse: ids.at(-1) || "", stale: ids.slice(0, -1) };
}

function prepareWorkspace(ctx, prune) {
  const tracked = trackedWorkspace(ctx);
  for (const id of tracked.stale) {
    console.log(`  → closing stale stacked crew workspace for ${ctx.project} (${id})`);
    closeWorkspace(ctx, id);
    dropState(ctx, ctx.project, "herdrws", "", id);
  }
  if (tracked.stale.length) prune();
  if (ctx.dry) return tracked.reuse;
  let reuse = tracked.reuse;
  const live = workspaceList(ctx).items.filter(item => [item.label, item.name, item.custom_title].includes(`trantor:${ctx.project}`));
  for (const item of live) {
    const id = item.workspace_id || item.id || "";
    if (!id || id === reuse || readRows(ctx).some(row => row.handle === id)) continue;
    if (!reuse) {
      console.log(`  → adopting existing untracked crew workspace for ${ctx.project} (${id})`);
      reuse = id;
      recordState(ctx, ctx.project, "herdrws", "__ws__", id);
    } else {
      console.log(`  → closing stray crew workspace for ${ctx.project} (${id})`);
      closeWorkspace(ctx, id);
    }
  }
  return reuse;
}

function replacementPane(ctx, workspace, spec, previousPane, resolve) {
  const seat = resolve(spec);
  if (!seat) return null;
  const old = readRows(ctx).filter(row => row.project === ctx.project && row.kind === "herdr" && row.agent === seat.agent).at(-1)?.handle || "";
  const target = old || previousPane;
  let pane;
  if (ctx.dry) {
    console.log(`[dry] herdr: reuse workspace ${workspace} — pane split for ${seat.agent}${old ? ` (replacing ${old})` : ""}`);
    pane = `%DRYT${spec.index}`;
  } else {
    pane = splitPane(ctx, target, "right");
    runSeat(ctx, pane, seat.agent, runnerCommand(ctx, seat.agent, seat.model));
  }
  if (old) {
    closePane(ctx, old);
    dropState(ctx, ctx.project, "herdr", seat.agent);
  }
  return { ...seat, pane };
}

export function spawnHerdr(ctx, specs, resolve, prune) {
  const reuse = prepareWorkspace(ctx, prune);
  let workspace = reuse;
  const panes = [];
  const columns = gridColumns(specs.length);
  for (let index = 0; index < specs.length; index += 1) {
    const spec = { value: specs[index], index };
    let seat;
    if (reuse) seat = replacementPane(ctx, workspace, spec, panes[index - 1] || "", value => resolve(value.value));
    else seat = freshPane(ctx, workspace, spec, panes, columns, resolve);
    if (!seat) continue;
    workspace = seat.workspace || workspace;
    panes.push(seat.pane);
    reportAgent(ctx, seat.pane, seat.agent);
    recordState(ctx, ctx.project, "herdr", seat.agent, seat.pane);
    console.log(`  → ${seat.agent} seat in herdr workspace (${ctx.project})`);
  }
  console.log(`— crew grouped in herdr: ONE workspace for ${ctx.project}, seats as named panes in its server. Teardown (this project only): trantor down —`);
}

function freshPane(ctx, workspace, spec, panes, columns, resolve) {
  const seat = resolve(spec.value);
  if (!seat) return null;
  const command = runnerCommand(ctx, seat.agent, seat.model);
  let pane = "";
  if (spec.index === 0) {
    if (ctx.dry) {
      console.log(`[dry] herdr: workspace create (cwd ${ctx.dir}) --label 'trantor:${ctx.project}' → root pane + run '${command}'`);
      workspace = "%DRYWS";
      pane = "%DRYT0";
    } else ({ workspace, pane } = createWorkspace(ctx, ctx.dir, `trantor:${ctx.project}`));
    recordState(ctx, ctx.project, "herdrws", "__ws__", workspace);
  } else {
    const firstRow = Math.floor(spec.index / columns) === 0;
    const direction = firstRow ? "right" : "down";
    const target = panes[firstRow ? spec.index - 1 : spec.index - columns] || "";
    if (ctx.dry) {
      console.log(`[dry] herdr: pane split ${target || "<focused>"} --direction ${direction} + run '${command}'`);
      pane = `%DRYT${spec.index}`;
    } else pane = splitPane(ctx, target, direction);
  }
  runSeat(ctx, pane, seat.agent, command);
  return { ...seat, pane, workspace };
}

export function paneHasAgent(ctx, pane) {
  const result = herdrCall(ctx, ["agent", "list"]);
  return result.ok && result.stdout.includes(`\"pane_id\":\"${pane}\"`);
}

export function createHerdrAdapter(ctx) {
  return {
    closeWorkspace: id => closeWorkspace(ctx, id),
    closePane: id => closePane(ctx, id),
    liveWorkspaces: () => workspaceList(ctx),
  };
}
