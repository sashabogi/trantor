import { describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { chatTabNeedsYou, initialTab, rightPanelApi } from "./rightPanelState";

describe("initialTab (#6499 item 1)", () => {
  it("returns Files when nothing was ever stored and the orchestrator is not live", () => {
    expect(initialTab(null, false)).toBe("files");
  });

  it("defaults to Chat when nothing was ever stored and the orchestrator IS live", () => {
    expect(initialTab(null, true)).toBe("chat");
  });

  it("a stored tab always wins over the live-orchestrator default", () => {
    expect(initialTab("git", true)).toBe("git");
    expect(initialTab("sessions", false)).toBe("sessions");
  });
});

describe("chatTabNeedsYou (#6499 item 2)", () => {
  it("only 'blocked' reads as needing the operator", () => {
    expect(chatTabNeedsYou("blocked")).toBe(true);
    expect(chatTabNeedsYou(" Blocked ")).toBe(true);
    expect(chatTabNeedsYou("working")).toBe(false);
    expect(chatTabNeedsYou("idle")).toBe(false);
    expect(chatTabNeedsYou(null)).toBe(false);
    expect(chatTabNeedsYou(undefined)).toBe(false);
  });
});

/** A faithful in-memory stand-in for config.json's `rightPanel` map, keyed by project — proves
 *  the actual get/set round trip (encode, decode, per-project isolation) rather than just the
 *  pure default logic above. Mirrors the shape right_panel.rs's Rust commands actually return. */
function fakeConfigStore() {
  const rows = new Map<string, { tab: string; dock: string }>();
  const invokeFn = async <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
    if (cmd === "right_panel_get") {
      // SAFETY: rightPanelApi.get always calls right_panel_get with a plain `{ project: string }`
      // object — never the array/buffer arms of InvokeArgs.
      const { project } = args as { project: string };
      // SAFETY: rightPanelApi.get types this call Promise<string>, JSON.parse-ing the reply.
      return JSON.stringify(rows.get(project) ?? null) as T;
    }
    if (cmd === "right_panel_set") {
      // SAFETY: rightPanelApi.set always calls right_panel_set with a plain
      // `{ project, tab, dock }` object of strings, never the array/buffer arms of InvokeArgs.
      const { project, tab, dock } = args as { project: string; tab: string; dock: string };
      const state = { tab, dock };
      rows.set(project, state);
      // SAFETY: rightPanelApi.set discards this reply (fire-and-forget), so its exact shape is
      // irrelevant — any string satisfies the Promise<string> it awaits.
      return JSON.stringify(state) as T;
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { invokeFn, rows };
}

describe("rightPanelApi persist + restore (#6499 item 0)", () => {
  it("get() on an untouched project returns null", async () => {
    const { invokeFn } = fakeConfigStore();
    expect(await rightPanelApi.get("trantor", invokeFn)).toBeNull();
  });

  it("set() then get() restores the exact tab — a simulated relaunch is just a fresh get()", async () => {
    const { invokeFn } = fakeConfigStore();
    await rightPanelApi.set("trantor", "chat", invokeFn);
    expect(await rightPanelApi.get("trantor", invokeFn)).toEqual({ tab: "chat", dock: "pane" });
  });

  it("two projects persist independently", async () => {
    const { invokeFn } = fakeConfigStore();
    await rightPanelApi.set("trantor", "chat", invokeFn);
    await rightPanelApi.set("crebral-health", "git", invokeFn);
    expect(await rightPanelApi.get("trantor", invokeFn)).toEqual({ tab: "chat", dock: "pane" });
    expect(await rightPanelApi.get("crebral-health", invokeFn)).toEqual({ tab: "git", dock: "pane" });
  });

  it("a foreign or corrupted stored shape decodes to null rather than throwing", async () => {
    // SAFETY: rightPanelApi.get types this call Promise<string>, JSON.parse-ing the reply — a
    // tab this build's PanelTab no longer lists must decode to null, not crash or pass through.
    const invokeFn = async <T,>(): Promise<T> => JSON.stringify({ tab: "not-a-real-tab" }) as T;
    expect(await rightPanelApi.get("trantor", invokeFn)).toBeNull();
  });

  it("a refusing invoke never throws out of get() or set()", async () => {
    const invokeFn = async <T,>(): Promise<T> => { throw new Error("no ipc"); };
    expect(await rightPanelApi.get("trantor", invokeFn)).toBeNull();
    await expect(rightPanelApi.set("trantor", "files", invokeFn)).resolves.toBeUndefined();
  });
});
