// #14512: the top bar's panel toggles drive panels that live inside the screens. A screen
// registers one slot per panel it actually has; the cluster and the panel chords read and
// drive the registered slot. No slot means the screen has no such panel: the toggle is
// disabled with a tooltip that says so.
import { useEffect, useRef, useSyncExternalStore } from "react";

export type PanelSide = "left" | "bottom" | "right";

export type PanelSlot = { open: boolean; toggle: () => void };

/** The registered slot per panel; null where the current screen has no such panel. */
export type PanelSlots = { left: PanelSlot | null; bottom: PanelSlot | null; right: PanelSlot | null };

const slots = new Map<PanelSide, PanelSlot>();
const listeners = new Set<() => void>();
let snapshot: PanelSlots = { left: null, bottom: null, right: null };

function publish() {
  snapshot = { left: slots.get("left") ?? null, bottom: slots.get("bottom") ?? null, right: slots.get("right") ?? null };
  listeners.forEach(notify => notify());
}

/** Publishes one panel's slot; the returned call unregisters it when the screen goes away. */
export function setPanelSlot(side: PanelSide, slot: PanelSlot): () => void {
  slots.set(side, slot);
  publish();
  return () => {
    if (slots.get(side) !== slot) return;
    slots.delete(side);
    publish();
  };
}

export const getPanelSlot = (side: PanelSide): PanelSlot | null => snapshot[side];
export const panelAvailable = (side: PanelSide): boolean => snapshot[side] !== null;

/** Runs the registered slot's toggle; false when this screen has no such panel. */
export function togglePanel(side: PanelSide): boolean {
  const slot = snapshot[side];
  if (!slot) return false;
  slot.toggle();
  return true;
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

export function usePanelSlots(): PanelSlots {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Registers a screen's panel for as long as it mounts; the toggle always runs the latest closure. */
export function usePanelSlot(side: PanelSide, panel: PanelSlot | null): void {
  const latest = useRef(panel);
  latest.current = panel;
  const present = panel !== null;
  const open = panel ? panel.open : false;
  useEffect(() => {
    if (!present) return;
    return setPanelSlot(side, { open, toggle: () => latest.current?.toggle() });
  }, [side, present, open]);
}
