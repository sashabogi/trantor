// Per-section open/closed persistence for the source control sidebar (#14044): one key under
// trantor.v2.scm per section, try/catch because storage can be blocked (private mode, webviews).
export const SCM_KEY_PREFIX = "trantor.v2.scm";

/** `fallback` is the state of a section the operator has not touched yet. */
export function readScmSectionOpen(section: string, fallback = true): boolean {
  try {
    const stored = localStorage.getItem(`${SCM_KEY_PREFIX}.${section}`);
    return stored === null ? fallback : stored !== "false";
  } catch { return fallback; }
}

export function writeScmSectionOpen(section: string, open: boolean): void {
  try { localStorage.setItem(`${SCM_KEY_PREFIX}.${section}`, String(open)); } catch { /* storage blocked: the choice lasts the session */ }
}

export type ScmView = "changes" | "files";

/** #14344: which of the two views the column shows. */
export function readScmView(): ScmView {
  try { return localStorage.getItem(`${SCM_KEY_PREFIX}.view`) === "files" ? "files" : "changes"; } catch { return "changes"; }
}

export function writeScmView(view: ScmView): void {
  try { localStorage.setItem(`${SCM_KEY_PREFIX}.view`, view); } catch { /* storage blocked: the choice lasts the session */ }
}
