// The classic/2.0 switch: one localStorage key, or ?ui=v2 for a one-off look (#v2-F).
export const UI_KEY = "trantor.ui";

export function wantsV2(search: string = window.location.search): boolean {
  if (new URLSearchParams(search).get("ui") === "v2") return true;
  try { return localStorage.getItem(UI_KEY) === "v2"; } catch { return false; }
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
  try { localStorage.removeItem(UI_KEY); } catch { /* storage blocked: nothing to clear */ }
  reloadWithout("ui");
}
