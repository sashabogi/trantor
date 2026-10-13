// @vitest-environment happy-dom
// The remembered project lens (#11597), proven the way rightPanelState.test.ts proves its seam:
// the round trip carries the new Graph value, per-project rows stay apart, and a broken or
// refusing store reads as nothing stored instead of throwing into the shell.
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import { initialLens, lensOf, projectLensApi } from "./lensState";

/** A faithful in-memory stand-in for config.json's `projectLens` map, keyed by project — proves
 *  the actual get/set round trip (encode, decode, per-project isolation). Mirrors the shape
 *  project_lens.rs's Rust commands actually return. */
function fakeConfigStore() {
  const rows = new Map<string, string>();
  const invokeFn = async <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
    if (cmd === "project_lens_get") {
      // SAFETY: projectLensApi.get always calls project_lens_get with a plain `{ project }`
      // object — never the array/buffer arms of InvokeArgs.
      const { project } = args as { project: string };
      // SAFETY: projectLensApi.get types this call Promise<string>, JSON.parse-ing the reply —
      // the generic only ever carries the JSON string the Rust command returns.
      return JSON.stringify(rows.get(project) ?? null) as T;
    }
    if (cmd === "project_lens_set") {
      // SAFETY: projectLensApi.set always calls project_lens_set with a plain
      // `{ project, lens }` object of strings, never the array/buffer arms of InvokeArgs.
      const { project, lens } = args as { project: string; lens: string };
      rows.set(project, lens);
      // SAFETY: projectLensApi.set discards this reply (fire-and-forget), so its exact shape is
      // irrelevant — any string satisfies the Promise<string> it awaits.
      return JSON.stringify(lens) as T;
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { invokeFn, rows };
}

describe("lensOf", () => {
  it("accepts every lens tab, the Graph value included", () => {
    for (const lens of ["workspace", "code", "graph", "board", "feed", "bus"]) {
      expect(lensOf(lens), lens).toBe(lens);
    }
  });

  it("refuses the compat values — they were never tabs — and nothing stored", () => {
    expect(lensOf("files")).toBeNull();
    expect(lensOf("review")).toBeNull();
    expect(lensOf("chat")).toBeNull();
    expect(lensOf(null)).toBeNull();
  });
});

describe("initialLens", () => {
  it("restores the stored lens, graph included, and defaults to board", () => {
    expect(initialLens("graph")).toBe("graph");
    expect(initialLens("code")).toBe("code");
    expect(initialLens(null)).toBe("board");
  });
});

describe("projectLensApi persist + restore (#6499's path, lens-shaped)", () => {
  it("round-trips one project's lens through the two commands", async () => {
    const { invokeFn } = fakeConfigStore();
    expect(await projectLensApi.get("trantor", invokeFn)).toBeNull();
    await projectLensApi.set("trantor", "graph", invokeFn);
    expect(await projectLensApi.get("trantor", invokeFn)).toBe("graph");
  });

  it("keeps projects apart", async () => {
    const { invokeFn, rows } = fakeConfigStore();
    await projectLensApi.set("trantor", "graph", invokeFn);
    await projectLensApi.set("crebral-health", "code", invokeFn);
    expect(await projectLensApi.get("trantor", invokeFn)).toBe("graph");
    expect(await projectLensApi.get("crebral-health", invokeFn)).toBe("code");
    expect(rows.get("trantor")).toBe("graph");
  });

  it("a broken or refusing store reads as nothing stored / stays in memory", async () => {
    // SAFETY: the replies below are handed to JSON.parse verbatim, exactly what the real
    // project_lens_get string is; `as T` only satisfies the seam's generic for these
    // deliberate bad rows — a rejection, malformed JSON, and a compat value.
    const rawReply = async <T,>(payload: string): Promise<T> => payload as T;
    expect(await projectLensApi.get("trantor", () => rawReply("{oops"))).toBeNull();
    expect(await projectLensApi.get("trantor", () => rawReply("not json"))).toBeNull();
    expect(await projectLensApi.get("trantor", () => rawReply(`"files"`))).toBeNull();
    await projectLensApi.set("trantor", "graph", async () => { throw new Error("read-only"); });
  });
});
