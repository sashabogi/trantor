// The Files column is a working preference: it opens by default, stays closed if you closed it,
// and the persistence boundary swallows a missing/quota-blocked localStorage without the shell
// ever knowing. The store is injected so the logic is testable under node (no localStorage).
import { describe, expect, it } from "vitest";
import { filesColumnOpen, persistFilesColumn, type FilesColumnStore } from "./filesColumn";

function fakeStore(): FilesColumnStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
  };
}

describe("files column", () => {
  it("defaults to open when nothing has been persisted", () => {
    expect(filesColumnOpen(fakeStore())).toBe(true);
  });

  it("stays closed when the persisted value is 0", () => {
    const s = fakeStore();
    s.setItem("trantor.files.open", "0");
    expect(filesColumnOpen(s)).toBe(false);
  });

  it("opens when the persisted value is 1", () => {
    const s = fakeStore();
    s.setItem("trantor.files.open", "1");
    expect(filesColumnOpen(s)).toBe(true);
  });

  it("persist writes 1 when open and 0 when closed", () => {
    const s = fakeStore();
    persistFilesColumn(s, true);
    expect(s.data.get("trantor.files.open")).toBe("1");
    persistFilesColumn(s, false);
    expect(s.data.get("trantor.files.open")).toBe("0");
  });

  it("a store that throws on read degrades to open, never crashes", () => {
    const s = fakeStore();
    s.getItem = () => { throw new Error("quota"); };
    expect(filesColumnOpen(s)).toBe(true);
  });

  it("a store that throws on write is swallowed — persistence is best-effort", () => {
    const s = fakeStore();
    s.setItem = () => { throw new Error("quota"); };
    expect(() => persistFilesColumn(s, true)).not.toThrow();
  });
});
