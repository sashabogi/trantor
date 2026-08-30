// The record rail's folded state (#5593): open by default, folding persists, storage is a
// boundary — a refusing or foreign store falls back to open, never to a crash.
import { describe, expect, it } from "vitest";
import { loadRailOpen, saveRailOpen } from "./prefs";
import type { Store } from "../chat/prefs";

function memStore(seed: Record<string, string> = {}): Store {
  const m = new Map(Object.entries(seed));
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe("record rail prefs", () => {
  it("defaults CLOSED when nothing was ever persisted — a log's resting state is folded", () => {
    expect(loadRailOpen(memStore())).toBe(false);
    expect(loadRailOpen(null)).toBe(false);
  });

  it("round-trips the fold", () => {
    const s = memStore();
    saveRailOpen(false, s);
    expect(loadRailOpen(s)).toBe(false);
    saveRailOpen(true, s);
    expect(loadRailOpen(s)).toBe(true);
  });

  it("treats foreign bytes as closed — decoded, never trusted", () => {
    expect(loadRailOpen(memStore({ "trantor.workspace.rail": "banana" }))).toBe(false);
  });

  it("a refusing store cannot crash either direction", () => {
    const refusing: Store = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(loadRailOpen(refusing)).toBe(false);
    expect(() => saveRailOpen(false, refusing)).not.toThrow();
  });
});
