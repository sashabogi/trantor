import { describe, expect, it } from "vitest";
import { expandedKey } from "../../ui/useExplorerData";
import { foldersToOpen, revealFolder } from "./revealFolder";

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
}

describe("foldersToOpen", () => {
  it("lists the folder and every folder above it", () => {
    expect(foldersToOpen("desktop/src/v2")).toEqual(["desktop", "desktop/src", "desktop/src/v2"]);
    expect(foldersToOpen("src/")).toEqual(["src"]);
    expect(foldersToOpen("")).toEqual([]);
  });
});

describe("revealFolder", () => {
  it("adds the folders to the project's open list without losing the ones already open", () => {
    const store = memory({ [expandedKey("trantor", null)]: JSON.stringify(["docs", "desktop"]) });
    revealFolder("trantor", null, "desktop/src", store);
    expect(JSON.parse(store.data[expandedKey("trantor", null)] ?? "[]")).toEqual(["docs", "desktop", "desktop/src"]);
  });

  it("keeps a seat's checkout apart from the project's", () => {
    const store = memory();
    revealFolder("trantor", "codex-8", "lib", store);
    expect(Object.keys(store.data)).toEqual([expandedKey("trantor", "codex-8")]);
    expect(expandedKey("trantor", "codex-8")).not.toBe(expandedKey("trantor", null));
  });

  it("writes nothing for the checkout root, and survives storage that throws or holds junk", () => {
    const store = memory();
    revealFolder("trantor", null, "", store);
    expect(store.data).toEqual({});
    const junk = memory({ [expandedKey("trantor", null)]: "{not json" });
    expect(() => revealFolder("trantor", null, "src", junk)).not.toThrow();
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(() => revealFolder("trantor", null, "src", blocked)).not.toThrow();
  });
});
