// The wake status of a freshly started project: the classic wake events and outcomes, held per
// project with a deadline for silence and a persistent delivery line (#14046).
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { GenesisSheetDeps } from "../../../features/genesis/GenesisSheet";
import { PLAIN_WAKE_KICKOFF } from "../../../features/genesis/genesis";
import { classifyWakeOutcome, wakeOutcomeIsTransient, WAKE_OUTCOME_MS, type WakeRowState } from "../../../features/genesis/wakeRow";
import { applyWakeProgress, WAKE_PROGRESS_EVENT, wakeProgressRowState, type WakeProgress } from "../../../features/genesis/wakeProgress";
import { guardedWake } from "../../../app/wakeGuard";
import { STALLED_TEXT, WAKE_DEADLINE_MS, wakeInFlight } from "./wakeModel";

export type ListenWake = (handler: (p: WakeProgress) => void) => Promise<() => void>;
export type Invoke = GenesisSheetDeps["invoke"];

export const listenTauriWake: ListenWake = handler => listen<WakeProgress>(WAKE_PROGRESS_EVENT, e => handler(e.payload));

type Timers = Map<string, ReturnType<typeof setTimeout>>;

function drop(map: Timers, p: string) {
  const t = map.get(p);
  if (t) clearTimeout(t);
  map.delete(p);
}

export function useWakeStatus(invokeFn: Invoke, listenWake: ListenWake) {
  const [wakes, setWakes] = useState<Map<string, WakeRowState>>(new Map());
  const inflight = useRef(new Set<string>());
  const started = useRef(new Set<string>());
  const wakeStarts = useRef(new Map<string, number>());
  const fades = useRef<Timers>(new Map());
  const deadlines = useRef<Timers>(new Map());

  const fade = useCallback((p: string) => {
    drop(fades.current, p);
    fades.current.set(p, setTimeout(() => {
      fades.current.delete(p);
      setWakes(prev => { const m = new Map(prev); if (m.get(p)?.phase === "outcome") m.delete(p); return m; });
    }, WAKE_OUTCOME_MS));
  }, []);
  const settle = useCallback((p: string, state: WakeRowState) => {
    drop(deadlines.current, p);
    setWakes(prev => new Map(prev).set(p, state));
    if (state.phase === "outcome" && state.kind !== "sent" && wakeOutcomeIsTransient(state)) fade(p);
  }, [fade]);
  const begin = useCallback((p: string) => {
    started.current.add(p);
    wakeStarts.current.set(p, Date.now());
    drop(fades.current, p);
    drop(deadlines.current, p);
    setWakes(prev => new Map(prev).set(p, { phase: "running" }));
    deadlines.current.set(p, setTimeout(() => {
      deadlines.current.delete(p);
      setWakes(prev => (wakeInFlight(prev.get(p)) ? new Map(prev).set(p, { phase: "outcome", kind: "error", text: STALLED_TEXT }) : prev));
    }, WAKE_DEADLINE_MS));
  }, []);
  /** Follow one project_wake call to its outcome; the answer passes through untouched. */
  const track = useCallback(async (p: string, run: Promise<string>): Promise<string> => {
    inflight.current.add(p);
    try {
      const out = await run;
      const outcome = classifyWakeOutcome(out, null);
      if (outcome.kind === "woken") {
        setWakes(prev => prev.get(p)?.phase === "running" ? new Map(prev).set(p, { phase: "kickoff", step: "pending" }) : prev);
      } else settle(p, outcome);
      return out;
    } catch (reason) {
      settle(p, classifyWakeOutcome(null, reason instanceof Error ? reason.message : String(reason)));
      throw reason;
    } finally { inflight.current.delete(p); }
  }, [settle]);

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    listenWake(p => {
      if (!alive) return;
      if (!started.current.has(p.project)) return;
      const next = wakeProgressRowState(p.phase, p.detail);
      setWakes(prev => applyWakeProgress(prev, p));
      if (next?.phase === "outcome") {
        drop(deadlines.current, p.project);
        if (next.kind !== "sent" && wakeOutcomeIsTransient(next)) fade(p.project);
      }
    }).then(off => { if (alive) stop = off; else off(); }, () => {});
    return () => { alive = false; stop?.(); };
  }, [listenWake, fade]);
  useEffect(() => () => { for (const t of [...fades.current.values(), ...deadlines.current.values()]) clearTimeout(t); }, []);

  const dismiss = useCallback((p: string) => {
    started.current.delete(p);
    wakeStarts.current.delete(p);
    drop(fades.current, p);
    drop(deadlines.current, p);
    setWakes(prev => { const m = new Map(prev); m.delete(p); return m; });
  }, []);

  /** The classic row's Wake: the same command with the same plain kickoff the CLI then overrides. */
  const retry = useCallback((p: string) => guardedWake(inflight.current, p, async () => {
    begin(p);
    await track(p, invokeFn<string>("project_wake", { project: p, kickoff: PLAIN_WAKE_KICKOFF })).catch(() => {});
  }), [invokeFn, begin, track]);

  return { wakes, wakeStarts: wakeStarts.current, begin, track, retry, dismiss };
}
