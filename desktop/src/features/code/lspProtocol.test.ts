import { describe, expect, it } from "vitest";
import { isReadyToken, progressEvent, type ProgressProbe } from "./lspProtocol";

describe("isReadyToken", () => {
  it("treats cachePriming (1.94) and Indexing (older) as the ready signal", () => {
    expect(isReadyToken("rustAnalyzer/cachePriming")).toBe(true);
    expect(isReadyToken("rustAnalyzer/Indexing")).toBe(true);
  });

  it("rejects the earlier phases that end first", () => {
    expect(isReadyToken("rustAnalyzer/Fetching")).toBe(false);
    expect(isReadyToken("rustAnalyzer/Roots Scanned")).toBe(false);
    expect(isReadyToken("rustAnalyzer/Building CrateGraph")).toBe(false);
    expect(isReadyToken("rustAnalyzer/Loading proc-macros")).toBe(false);
  });
});

describe("progressEvent", () => {
  it("returns null for anything that is not $/progress", () => {
    expect(progressEvent({ method: "textDocument/publishDiagnostics" })).toBeNull();
  });

  it("extracts kind, title and token from a $/progress notification", () => {
    const msg: ProgressProbe = {
      method: "$/progress",
      params: { token: "rustAnalyzer/cachePriming", value: { kind: "begin", title: "cachePriming" } },
    };
    expect(progressEvent(msg)).toEqual({
      kind: "begin",
      title: "cachePriming",
      token: "rustAnalyzer/cachePriming",
    });
  });

  it("extracts the end kind with a null title", () => {
    const msg: ProgressProbe = {
      method: "$/progress",
      params: { token: "rustAnalyzer/cachePriming", value: { kind: "end" } },
    };
    expect(progressEvent(msg)).toEqual({ kind: "end", title: null, token: "rustAnalyzer/cachePriming" });
  });
});
