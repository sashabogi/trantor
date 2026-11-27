// @vitest-environment happy-dom
// #14513: the shell's reopen rule — which stored value becomes a screen, and what a relaunch
// lands on when pieces are missing. The lens round trip is proven the way lensState.test.ts
// proves its seam: a faithful in-memory stand-in for the projectLens rows project_lens.rs keeps.
import type { InvokeArgs } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fleetScreenOf, initialScreen, lensScreenOf, projectLensGet, projectLensSet, rememberScreen, SCREEN_KEY } from "./screenState";

/** The in-memory stand-in for config.json's `projectLens` rows, or a store that always refuses. */
function fakeLensStore(mode: "ok" | "refuse" = "ok") {
  const rows = new Map<string, string>();
  const sets: { project: string; lens: string }[] = [];
  const invokeFn = async <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
    if (mode === "refuse") throw new Error("store away");
    if (cmd === "project_lens_get") {
      // SAFETY: projectLensGet always calls project_lens_get with a plain `{ project }`
      // object — never the array/buffer arms of InvokeArgs.
      const { project } = args as { project: string };
      // SAFETY: projectLensGet types this call Promise<string>, JSON.parse-ing the reply —
      // the generic only ever carries the JSON string the Rust command returns.
      return JSON.stringify(rows.get(project) ?? null) as T;
    }
    if (cmd === "project_lens_set") {
      // SAFETY: projectLensSet always calls project_lens_set with a plain `{ project, lens }`
      // object of strings, never the array/buffer arms of InvokeArgs.
      const { project, lens } = args as { project: string; lens: string };
      sets.push({ project, lens });
      rows.set(project, lens);
      // SAFETY: projectLensSet discards this reply, so its exact shape is irrelevant — any
      // string satisfies the Promise<string> it awaits.
      return JSON.stringify(lens) as T;
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { invokeFn, rows, sets };
}

let mem: Map<string, string>;
beforeEach(() => {
  mem = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
});

describe("screenState validators", () => {
  it("lensScreenOf takes only lens screens the shell can show", () => {
    expect(lensScreenOf("workspace")).toBe("workspace");
    expect(lensScreenOf("code")).toBe("code");
    expect(lensScreenOf("board")).toBe("board");
    // a classic-only lens, a fleet screen and junk never become a screen
    expect(lensScreenOf("chat")).toBeNull();
    expect(lensScreenOf("dashboard")).toBeNull();
    expect(lensScreenOf("nope")).toBeNull();
    expect(lensScreenOf(null)).toBeNull();
  });

  it("fleetScreenOf takes only fleet screens", () => {
    expect(fleetScreenOf("dashboard")).toBe("dashboard");
    expect(fleetScreenOf("inbox")).toBe("inbox");
    expect(fleetScreenOf("workspace")).toBeNull();
    expect(fleetScreenOf(null)).toBeNull();
  });
});

describe("initialScreen restore order and fallbacks", () => {
  it("the fleet screen you left wins over the project's lens", () => {
    expect(initialScreen("inbox", "code", "trantor")).toBe("inbox");
  });

  it("with no fleet screen the project's remembered lens reopens", () => {
    expect(initialScreen(null, "code", "trantor")).toBe("code");
  });

  it("nothing stored lands on Dashboard, with or without a project", () => {
    expect(initialScreen(null, null, "trantor")).toBe("dashboard");
  });

  it("a missing project lands on Dashboard even with a lens stored", () => {
    expect(initialScreen(null, "code", "")).toBe("dashboard");
    expect(initialScreen(null, null, "")).toBe("dashboard");
  });
});

describe("projectLens round-trip", () => {
  it("reads the stored lens and drops values the shell cannot show", async () => {
    const store = fakeLensStore();
    store.rows.set("trantor", "code");
    expect(await projectLensGet("trantor", store.invokeFn)).toBe("code");
    store.rows.set("trantor", "chat");
    expect(await projectLensGet("trantor", store.invokeFn)).toBeNull();
    store.rows.delete("trantor");
    expect(await projectLensGet("trantor", store.invokeFn)).toBeNull();
  });

  it("a refusing command reads as null and a refusing store stays quiet", async () => {
    const refusing = fakeLensStore("refuse");
    expect(await projectLensGet("trantor", refusing.invokeFn)).toBeNull();
    await expect(projectLensSet("trantor", "code", refusing.invokeFn)).resolves.toBeUndefined();
  });
});

describe("rememberScreen writes", () => {
  it("a fleet screen is remembered globally", () => {
    rememberScreen("inbox", "trantor");
    expect(mem.get(SCREEN_KEY)).toBe("inbox");
  });

  it("a lens screen is remembered per project and retires the fleet key", () => {
    mem.set(SCREEN_KEY, "inbox");
    const store = fakeLensStore();
    rememberScreen("code", "trantor", store.invokeFn);
    expect(mem.has(SCREEN_KEY)).toBe(false);
    expect(store.rows.get("trantor")).toBe("code");
    expect(store.sets).toEqual([{ project: "trantor", lens: "code" }]);
  });

  it("a lens screen with no project only retires the fleet key", () => {
    mem.set(SCREEN_KEY, "inbox");
    const store = fakeLensStore();
    rememberScreen("code", "", store.invokeFn);
    expect(mem.has(SCREEN_KEY)).toBe(false);
    expect(store.sets).toEqual([]);
  });

  it("blocked storage never throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); }, clear: () => {}, key: () => null, length: 0,
    });
    expect(() => rememberScreen("inbox", "trantor")).not.toThrow();
    expect(() => rememberScreen("code", "trantor")).not.toThrow();
  });
});
