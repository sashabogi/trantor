import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appleScript, appleScriptString, call, commandExists, gridColumns, parseJsonOutput, runnerCommand } from "./core.mjs";
import { dropState, readRows, recordState } from "./state.mjs";

function binary(ctx) {
  return commandExists("cmux", ctx.env) ? "cmux" : "/Applications/cmux.app/Contents/Resources/bin/cmux";
}

function cmuxCall(ctx, args, options = {}) {
  return call(binary(ctx), args, { ...options, env: { ...ctx.env, CMUX_QUIET: "1" } });
}

function socketWorks(ctx) {
  return ctx.have.cmux && cmuxCall(ctx, ["ping"]).ok;
}

export function liveWorkspaces(ctx) {
  if (!socketWorks(ctx)) return { proven: false, ids: new Set(), names: new Set(), items: [] };
  const result = cmuxCall(ctx, ["workspace", "list", "--id-format", "both", "--json"]);
  const parsed = parseJsonOutput(result.stdout);
  if (!parsed) return { proven: false, ids: new Set(), names: new Set(), items: [] };
  const items = Array.isArray(parsed) ? parsed : parsed.workspaces || [];
  return {
    proven: true,
    ids: new Set(items.map(item => item.id).filter(Boolean)),
    names: new Set(items.map(item => item.custom_title || item.name).filter(Boolean)),
    items,
  };
}

export function closeWorkspace(ctx, id) {
  if (ctx.dry) { console.log(`[dry] cmux close-workspace ${id}`); return; }
  if (socketWorks(ctx) && cmuxCall(ctx, ["close-workspace", "--workspace", id]).ok) return;
  call("osascript", [], { input: `tell application "cmux"\nrepeat with w in windows\nrepeat with tt in tabs of w\nif (id of tt) is "${id}" then close tab tt\nend repeat\nend repeat\nend tell\n` });
}

export function closePane(ctx, id) {
  if (ctx.dry) { console.log(`[dry] cmux close-surface ${id}`); return; }
  if (socketWorks(ctx) && cmuxCall(ctx, ["close-surface", "--surface", id]).ok) return;
  call("osascript", [], { input: `tell application "cmux"\nrepeat with tr in terminals\nif (id of tr) is "${id}" then close tr\nend repeat\nend tell\n` });
}

function seatLauncher(ctx, agent, command) {
  mkdirSync(ctx.seatDir, { recursive: true });
  const file = join(ctx.seatDir, `${ctx.project}-${agent}.sh`);
  if (!ctx.dry) writeFileSync(file, `#!/bin/bash\nprintf "\\033]0;%s\\007" ${JSON.stringify(`${agent} · ${ctx.project}`)}\n${command}\n`);
  return file;
}

function tracked(ctx) {
  const ids = readRows(ctx).filter(row => row.project === ctx.project && row.kind === "cmuxws").map(row => row.handle);
  return { reuse: ids.at(-1) || "", stale: ids.slice(0, -1) };
}

function prepare(ctx, prune) {
  const result = tracked(ctx);
  for (const id of result.stale) {
    console.log(`  → closing stale stacked crew workspace for ${ctx.project} (${id})`);
    closeWorkspace(ctx, id);
    dropState(ctx, ctx.project, "cmuxws", "", id);
  }
  if (result.stale.length) prune();
  if (ctx.dry || result.reuse) return result.reuse;
  const candidate = liveWorkspaces(ctx).items.find(item => [item.custom_title, item.name].includes(`trantor:${ctx.project}`));
  const id = candidate?.id || "";
  if (id) {
    console.log(`  → adopting existing untracked crew workspace for ${ctx.project} (${id})`);
    recordState(ctx, ctx.project, "cmuxws", "__ws__", id);
  }
  return id;
}

function surfaceFrom(result) {
  const parsed = parseJsonOutput(result.stdout);
  return parsed?.surface_id || parsed?.surface_ref || parsed?.id || "";
}

function newWorkspace(ctx, launcher) {
  const created = cmuxCall(ctx, ["new-workspace", "--cwd", ctx.dir, "--command", `bash ${launcher}`]);
  const ref = created.stdout.split(/\s+/)[1] || "";
  const list = liveWorkspaces(ctx).items;
  const workspace = list.find(item => item.ref === ref)?.id || list.at(-1)?.id || "";
  if (workspace) cmuxCall(ctx, ["rename-workspace", "--workspace", workspace, `trantor:${ctx.project}`]);
  const panes = cmuxCall(ctx, ["list-pane-surfaces", "--workspace", workspace, "--id-format", "uuids", "--json"]);
  const parsed = parseJsonOutput(panes.stdout);
  const first = (parsed?.surfaces || parsed?.panes || (Array.isArray(parsed) ? parsed : []))[0];
  return { workspace, pane: first?.id || first?.surface_id || "" };
}

function split(ctx, workspace, direction, target, launcher) {
  const args = ["new-split", direction, "--workspace", workspace];
  if (target) args.push("--surface", target);
  args.push("--id-format", "uuids", "--json");
  const pane = surfaceFrom(cmuxCall(ctx, args));
  if (pane) {
    cmuxCall(ctx, ["send", "--surface", pane, `bash ${launcher}`]);
    cmuxCall(ctx, ["send-key", "--surface", pane, "enter"]);
  }
  return pane;
}

export function spawnCmux(ctx, specs, resolve, prune) {
  if (!socketWorks(ctx)) return spawnAppleScript(ctx, specs, resolve);
  let workspace = prepare(ctx, prune);
  const reuse = Boolean(workspace);
  const panes = [];
  const columns = gridColumns(specs.length);
  for (let index = 0; index < specs.length; index += 1) {
    const seat = resolve(specs[index]);
    if (!seat) continue;
    const launcher = seatLauncher(ctx, seat.agent, runnerCommand(ctx, seat.agent, seat.model));
    const old = reuse ? readRows(ctx).filter(row => row.project === ctx.project && row.kind === "cmux" && row.agent === seat.agent).at(-1)?.handle || "" : "";
    let pane = "";
    if (reuse) {
      console.log(ctx.dry ? `[dry] cmux: reuse workspace ${workspace} — new-split for ${seat.agent}${old ? ` (replacing ${old})` : ""}` : `  → reusing workspace ${workspace}`);
      pane = ctx.dry ? `%DRYT${index}` : split(ctx, workspace, "right", old || panes.at(-1) || "", launcher);
      if (old) { closePane(ctx, old); dropState(ctx, ctx.project, "cmux", seat.agent); }
    } else if (index === 0) {
      if (ctx.dry) {
        console.log(`[dry] cmux: new-workspace (cwd ${ctx.dir}) --command 'bash ${launcher}' → rename 'trantor:${ctx.project}'`);
        workspace = "%DRYWS"; pane = "%DRYT0";
      } else ({ workspace, pane } = newWorkspace(ctx, launcher));
      recordState(ctx, ctx.project, "cmuxws", "__ws__", workspace);
    } else {
      const firstRow = Math.floor(index / columns) === 0;
      const direction = firstRow ? "right" : "down";
      const target = panes[firstRow ? index - 1 : index - columns] || "";
      if (ctx.dry) {
        console.log(`[dry] cmux: new-split ${direction} --surface ${target || "<focused>"} + send 'bash ${launcher}'`);
        pane = `%DRYT${index}`;
      } else pane = split(ctx, workspace, direction, target, launcher);
    }
    panes.push(pane);
    recordState(ctx, ctx.project, "cmux", seat.agent, pane);
    console.log(`  → ${seat.agent} seat in cmux workspace (${ctx.project})`);
  }
  console.log(`— crew grouped in cmux: ONE workspace tab for ${ctx.project}, seats tiled + sidebar status. Teardown (this project only): trantor down —`);
}

function spawnAppleScript(ctx, specs, resolve) {
  console.log("— cmux control socket is OFF (mode cmuxOnly) → using AppleScript (works; no native sidebar status).");
  console.log("  Enable the full integration: add \"automation\": { \"socketControlMode\": \"allowAll\" } to");
  console.log("  ~/.config/cmux/cmux.json (cmux auto-reloads). —");
  let tab = prepareAppleScriptWorkspace(ctx);
  const reuse = Boolean(tab);
  const panes = [];
  const columns = gridColumns(specs.length);
  for (let index = 0; index < specs.length; index += 1) {
    const seat = resolve(specs[index]);
    if (!seat) continue;
    const launcher = seatLauncher(ctx, seat.agent, runnerCommand(ctx, seat.agent, seat.model));
    const old = reuse ? readRows(ctx).filter(row => row.project === ctx.project && row.kind === "cmux" && row.agent === seat.agent).at(-1)?.handle || "" : "";
    let pane;
    if (!tab && index === 0) {
      if (ctx.dry) {
        console.log(`[dry] cmux(AppleScript): new tab (trantor:${ctx.project}) + run 'bash ${launcher}'`);
        tab = "%DRYTAB"; pane = "%DRYT0";
      } else ({ tab, pane } = createAppleScriptTab(ctx, launcher));
      recordState(ctx, ctx.project, "cmuxws", "__ws__", tab);
    } else {
      const firstRow = Math.floor(index / columns) === 0;
      const direction = old || firstRow ? "right" : "down";
      const target = old || panes[firstRow ? index - 1 : index - columns] || "";
      if (ctx.dry) {
        console.log(`[dry] cmux(AppleScript): split ${direction} from ${target || "<focused>"} + run 'bash ${launcher}'`);
        pane = `%DRYT${index}`;
      } else pane = splitAppleScriptPane(ctx, tab, target, direction, launcher);
      if (old && pane && pane !== "ERR") { closePane(ctx, old); dropState(ctx, ctx.project, "cmux", seat.agent); }
    }
    panes.push(pane);
    recordState(ctx, ctx.project, "cmux", seat.agent, pane);
    console.log(`  → ${seat.agent} seat in cmux workspace (${ctx.project})`);
  }
  console.log(`— crew grouped in cmux (AppleScript): ONE workspace tab for ${ctx.project}, seats tiled. Teardown: trantor down —`);
}

function prepareAppleScriptWorkspace(ctx) {
  const ids = readRows(ctx).filter(row => row.project === ctx.project && row.kind === "cmuxws").map(row => row.handle);
  const reuse = ids.at(-1) || "";
  for (const id of ids.slice(0, -1)) {
    console.log(`  → closing stale stacked crew workspace for ${ctx.project} (${id})`);
    closeWorkspace(ctx, id);
    dropState(ctx, ctx.project, "cmuxws", "", id);
  }
  if (!reuse || ctx.dry) return reuse;
  const script = `tell application "cmux"\nrepeat with w in windows\nrepeat with tt in tabs of w\nif (id of tt) is "${appleScriptString(reuse)}" then return "OK"\nend repeat\nend repeat\nreturn "ERR"\nend tell\n`;
  if (appleScript(script).stdout === "OK") {
    console.log(`  → reusing existing crew workspace for ${ctx.project} (${reuse})`);
    return reuse;
  }
  dropState(ctx, ctx.project, "cmuxws", "", reuse);
  dropState(ctx, ctx.project, "cmux");
  return "";
}

function createAppleScriptTab(ctx, launcher) {
  const script = `tell application "cmux"\nactivate\nif (count of windows) is 0 then\nnew window\ndelay 0.5\nend if\nset t to (new tab)\ndelay 0.4\nset term1 to (focused terminal of t)\ninput text ("bash ${appleScriptString(launcher)}" & return) to term1\nreturn (id of t) & "|" & (id of term1)\nend tell\n`;
  const [tab = "", pane = ""] = appleScript(script).stdout.split("|");
  return { tab, pane };
}

function splitAppleScriptPane(ctx, tab, target, direction, launcher) {
  const script = `tell application "cmux"\nset theTab to missing value\nrepeat with w in windows\nrepeat with tt in tabs of w\nif (id of tt) is "${appleScriptString(tab)}" then set theTab to tt\nend repeat\nend repeat\nif theTab is missing value then return "ERR"\nset srcTerm to missing value\nrepeat with tm in terminals of theTab\nif (id of tm) is "${appleScriptString(target)}" then set srcTerm to tm\nend repeat\nif srcTerm is missing value then set srcTerm to (focused terminal of theTab)\nset newterm to (split srcTerm direction ${direction})\ndelay 0.25\ninput text ("bash ${appleScriptString(launcher)}" & return) to newterm\nreturn (id of newterm)\nend tell\n`;
  return appleScript(script).stdout;
}

export function createCmuxAdapter(ctx) {
  return {
    closeWorkspace: id => closeWorkspace(ctx, id),
    closePane: id => closePane(ctx, id),
    liveWorkspaces: () => liveWorkspaces(ctx),
  };
}
