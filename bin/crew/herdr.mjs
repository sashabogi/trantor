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

// A pane herdr LISTS is not always a pane herdr can RUN (#7247: a restart kept w2:p8 in the
// layout, so list/get/rename answered, while read/process-info/run said pane_not_found). Rename
// is a layout question; process-info is the terminal question, and only a terminal hosts a session.
export function paneAlive(ctx, pane) {
  if (!pane) return false;
  const result = herdrCall(ctx, ["pane", "process-info", "--pane", pane]);
  const parsed = parseJsonOutput(result.stdout);
  return Boolean(result.ok && parsed && !parsed.error && parsed.result?.process_info);
}

export function workspacePane(ctx, workspace, preferredCwd) {
  const panes = listPanes(ctx);
  const matches = panes.filter(pane => (pane.workspace_id || pane.workspace || "") === workspace);
  const preferred = matches.filter(pane => (pane.cwd || "") === preferredCwd);
  const ordered = [...preferred, ...matches.filter(pane => !preferred.includes(pane))];
  for (const pane of ordered) {
    const id = pane.pane_id || pane.id || "";
    if (id && paneAlive(ctx, id)) return id;
  }
  return "";
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
  // #7285: duplicate rows of ONE workspace must dedupe — a takeover used to append a second row of
  // the live workspace, and slice(0,-1) then handed that live workspace to the stale list.
  const ids = [];
  for (const id of readRows(ctx).filter(row => row.project === ctx.project && row.kind === "herdrws").map(row => row.handle)) {
    const at = ids.indexOf(id);
    if (at >= 0) ids.splice(at, 1);
    ids.push(id);
  }
  return { reuse: ids.at(-1) || "", stale: ids.slice(0, -1) };
}

function listPanes(ctx) {
  const parsed = parseJsonOutput(herdrCall(ctx, ["pane", "list"]).stdout);
  return Array.isArray(parsed) ? parsed : parsed?.panes || parsed?.result?.panes || [];
}

// #7285: the workspaces hosting THIS project's tracked orchestrator pane. Herdr pane ids embed
// their workspace (#7247 forensics: 'w2:p4Y' lived in w2), so the handle prefix names the home
// without a round trip; when herdr answers, the pane list is a second opinion (stub ids carry no
// prefix). Closing such a workspace kills the orchestrator's shell.
function orchPaneWorkspaces(ctx) {
  const handles = readRows(ctx).filter(row => row.project === ctx.project && row.kind === "orch").map(row => row.handle);
  if (!handles.length) return new Set();
  const spaces = new Set(handles.map(handle => handle.split(":")[0]).filter(Boolean));
  if (ctx.dry) return spaces;
  const tracked = new Set(handles);
  for (const pane of listPanes(ctx)) {
    if (!tracked.has(pane.pane_id || pane.id || "")) continue;
    const space = pane.workspace_id || pane.workspace || "";
    if (space) spaces.add(space);
  }
  return spaces;
}

function prepareWorkspace(ctx, prune) {
  const tracked = trackedWorkspace(ctx);
  const orchSpaces = orchPaneWorkspaces(ctx);
  for (const id of tracked.stale) {
    // #7285: never close reuse itself, nor a workspace hosting the tracked orch pane — `up` once
    // killed its own orchestrator that way. The row stays: the workspace is still live.
    if (id === tracked.reuse || orchSpaces.has(id)) continue;
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

function replacementPane(ctx, workspace, spec, hostPane, resolve) {
  const seat = resolve(spec);
  if (!seat) return null;
  const old = readRows(ctx).filter(row => row.project === ctx.project && row.kind === "herdr" && row.agent === seat.agent).at(-1)?.handle || "";
  let pane;
  if (ctx.dry) {
    console.log(`[dry] herdr: reuse workspace ${workspace} — pane split for ${seat.agent}${old ? ` (replacing ${old})` : ""}`);
    pane = `%DRYT${spec.index}`;
  } else {
    pane = splitPane(ctx, hostPane, "right", ctx.dir);
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
  let hostPane = "";
  if (reuse) {
    hostPane = ctx.dry ? `%DRYHOST(${reuse})` : workspacePane(ctx, reuse, ctx.dir);
    if (!hostPane) throw new Error(`trantor up: workspace ${reuse} has no live pane to host crew seats`);
  }
  const panes = [];
  const columns = gridColumns(specs.length);
  for (let index = 0; index < specs.length; index += 1) {
    const spec = { value: specs[index], index };
    let seat;
    if (reuse) seat = replacementPane(ctx, workspace, spec, panes.at(-1) || hostPane, value => resolve(value.value));
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
    } else pane = splitPane(ctx, target, direction, ctx.dir);
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
    paneAlive: pane => paneAlive(ctx, pane),
  };
}
