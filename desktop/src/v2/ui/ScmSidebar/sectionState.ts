// Per-section open/closed persistence for the source control sidebar (#14044): one key under
// trantor.v2.scm per section, try/catch because storage can be blocked (private mode, webviews).
export const SCM_KEY_PREFIX = "trantor.v2.scm";

export function readScmSectionOpen(section: string): boolean {
  try { return localStorage.getItem(`${SCM_KEY_PREFIX}.${section}`) !== "false"; } catch { return true; }
}

export function writeScmSectionOpen(section: string, open: boolean): void {
  try { localStorage.setItem(`${SCM_KEY_PREFIX}.${section}`, String(open)); } catch { /* storage blocked: the choice lasts the session */ }
}
