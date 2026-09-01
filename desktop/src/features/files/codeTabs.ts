// The Code lens's tab model (#5813), lifted from Orca's preview/pin anatomy
// (RESEARCH-orca-renderer.md §4): tabs carry an identity of scope+path, a plain click opens a
// PREVIEW that the next preview click replaces, and only an explicit pin makes a tab permanent
// (split-open.ts:26-29 — `!targetGroupId && event?.openAsPermanent !== true`). Pure so the two
// rules the operator can feel — "my pinned tabs never move", "the dirty dot only follows the
// draft" — are unit-tested.
export type CodeTab = {
  /** `${scope}:${path}` — scope is "project" or the seat name. The identity: the same path in
   *  two worktrees is two files and two tabs. */
  key: string;
  scope: string;
  path: string;
  /** The orthogonal view: the editor, or the live-editable diff vs HEAD. */
  view: "code" | "changes";
  pinned: boolean;
  dirty: boolean;
};

export const tabKey = (scope: string, path: string): string => `${scope}:${path}`;

export function findTab(tabs: CodeTab[], scope: string, path: string): CodeTab | undefined {
  return tabs.find(t => t.key === tabKey(scope, path));
}

/**
 * Open a path under a scope, preview semantics. If the currently ACTIVE tab is a preview, it is
 * replaced in place (same slot, same activation); otherwise a fresh preview tab opens at the end
 * and becomes active. An existing tab for the path — pinned or not — is just activated and its
 * view set, never duplicated, never moved.
 */
export function openInTabs(
  tabs: CodeTab[],
  activeKey: string | null,
  scope: string,
  path: string,
  view: "code" | "changes",
): { tabs: CodeTab[]; activeKey: string } {
  const key = tabKey(scope, path);
  const existing = tabs.find(t => t.key === key);
  if (existing) {
    return {
      tabs: tabs.map(t => (t.key === key ? { ...t, view } : t)),
      activeKey: key,
    };
  }
  const active = tabs.find(t => t.key === activeKey);
  if (active && !active.pinned) {
    return {
      tabs: tabs.map(t => (t.key === activeKey ? { ...t, scope, path, key, view, dirty: false } : t)),
      activeKey: key,
    };
  }
  return { tabs: [...tabs, { key, scope, path, view, pinned: false, dirty: false }], activeKey: key };
}

/** Pin toggles permanence; unpinning is allowed and the tab simply becomes the preview again. */
export function togglePin(tabs: CodeTab[], key: string): CodeTab[] {
  return tabs.map(t => (t.key === key ? { ...t, pinned: !t.pinned } : t));
}

/** Set one tab's dirty dot. Nothing else moves. */
export function markDirty(tabs: CodeTab[], key: string, dirty: boolean): CodeTab[] {
  return tabs.map(t => (t.key === key ? { ...t, dirty } : t));
}

/** Close a tab; if it was active, activation moves to the nearest tab of the same scope. */
export function closeTab(
  tabs: CodeTab[],
  activeKey: string | null,
  key: string,
): { tabs: CodeTab[]; activeKey: string | null } {
  const idx = tabs.findIndex(t => t.key === key);
  const next = tabs.filter(t => t.key !== key);
  if (idx === -1 || key !== activeKey) return { tabs: next, activeKey };
  const scope = tabs[idx].scope;
  const sameScope = next.filter(t => t.scope === scope);
  if (sameScope.length === 0) {
    return { tabs: next, activeKey: next[next.length - 1]?.key ?? null };
  }
  const neighbor = sameScope[Math.min(Math.max(idx - 1, 0), sameScope.length - 1)];
  return { tabs: next, activeKey: neighbor.key };
}
