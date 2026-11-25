// The classic/2.0 switch: 2.0 is the app since release 2.0.0; classic is one stored choice away,
// or ?ui=classic (?ui=v2) for a one-off look (#v2-F).
export const UI_KEY = "trantor.ui";
const CLASSIC = "classic";

export function wantsV2(search: string = window.location.search): boolean {
  const once = new URLSearchParams(search).get("ui");
  if (once === "v2") return true;
  if (once === CLASSIC) return false;
  try { return localStorage.getItem(UI_KEY) !== CLASSIC; } catch { return true; }
}

function reloadWithout(param: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete(param);
  window.location.replace(url.toString());
}

export function enterV2() {
  try { localStorage.setItem(UI_KEY, "v2"); } catch { /* storage blocked: ?ui=v2 still works */ }
  window.location.reload();
}

export function backToClassic() {
  try { localStorage.setItem(UI_KEY, CLASSIC); } catch { /* storage blocked: ?ui=classic still works */ }
  reloadWithout("ui");
}
