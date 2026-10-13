// wakeGuard.ts: the sidebar's in-flight wake guard, one slot per project (#11640). It used to be a
// single global flag, so one hung or long wake swallowed every other project's click silently.

/** Run `run` for `project` unless that project already has a wake in flight. Returns false when
 *  the click was ignored. Another project's wake never blocks this one; the slot is released on
 *  every exit path, a throw included. */
export async function guardedWake(inflight: Set<string>, project: string, run: () => Promise<void>): Promise<boolean> {
  if (inflight.has(project)) return false;
  inflight.add(project);
  try {
    await run();
  } finally {
    inflight.delete(project);
  }
  return true;
}
