// The shell's reopen state (#14513): the last fleet screen in localStorage, the last project
// screen per project through the project_lens commands the classic app shares — so a relaunch
// lands where the operator left it instead of always on Dashboard. Stored values only ever
// come back through the validators below; anything else falls back.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { FLEET_SCREENS, LENS_SCREENS, isLensScreen, type FleetScreen, type LensScreen, type Screen } from "../routes";

type InvokeFn = <T>(cmd: string, args?: InvokeArgs) => Promise<T>;

/** Where the last fleet screen lives; a lens screen clears it (the current screen is the project's). */
export const SCREEN_KEY = "trantor.v2.screen";

/** The stored value if it names a lens screen the shell can show, else null. */
export function lensScreenOf(stored: string | null): LensScreen | null {
  return LENS_SCREENS.find(l => l === stored) ?? null;
}

/** The stored value if it names a fleet screen, else null. */
export function fleetScreenOf(stored: string | null): FleetScreen | null {
  return FLEET_SCREENS.find(s => s === stored) ?? null;
}

/** The screen a relaunch opens on: the fleet screen you left, else the project's remembered
 * lens, else Dashboard — nothing stored and no project both land there. */
export function initialScreen(fleet: FleetScreen | null, lens: LensScreen | null, project: string): Screen {
  if (fleet) return fleet;
  if (project && lens) return lens;
  return "dashboard";
}

/** The project's remembered screen, or null when nothing valid was stored. */
export async function projectLensGet(project: string, invokeFn: InvokeFn = invoke): Promise<LensScreen | null> {
  try {
    // SAFETY: the Rust side only ever stores a string this module itself wrote through set
    // below (project_lens.rs's map), or JSON null for an untouched project.
    const parsed = JSON.parse(await invokeFn<string>("project_lens_get", { project })) as string | null;
    return lensScreenOf(parsed);
  } catch { return null; }
}

/** Remember the project's screen; a refusing store keeps this session's choice in memory only. */
export async function projectLensSet(project: string, lens: LensScreen, invokeFn: InvokeFn = invoke): Promise<void> {
  try { await invokeFn("project_lens_set", { project, lens }); }
  catch { /* a refusing store keeps this session's choice in memory only */ }
}

/** Record where a navigation left the shell: a fleet screen globally, a lens screen per
 * project (which also retires the fleet key — the current screen is the project's now). */
export function rememberScreen(screen: Screen, project: string, invokeFn: InvokeFn = invoke): void {
  try {
    if (isLensScreen(screen)) {
      localStorage.removeItem(SCREEN_KEY);
      if (project) void projectLensSet(project, screen, invokeFn);
    } else {
      localStorage.setItem(SCREEN_KEY, screen);
    }
  } catch { /* storage blocked: this session's choice lasts the session */ }
}
