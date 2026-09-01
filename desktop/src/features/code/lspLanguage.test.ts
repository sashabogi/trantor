// The path → language-server mapping: which monaco language ids a server serves, and what binary
// each is called. Pure so the honest "not installed: <name>" status line and the "no server for
// this file" decision are testable without booting the editor or the Rust bridge.
import { describe, expect, it } from "vitest";
import { lspLanguageFor, lspServerName } from "./lspLanguage";

describe("lspLanguageFor", () => {
  it("serves rust, typescript/javascript, and python files", () => {
    expect(lspLanguageFor("src/main.rs")).toBe("rust");
    expect(lspLanguageFor("src/App.tsx")).toBe("typescript");
    expect(lspLanguageFor("src/app.ts")).toBe("typescript");
    expect(lspLanguageFor("src/app.js")).toBe("javascript");
    expect(lspLanguageFor("src/app.py")).toBe("python");
  });

  it("returns null for languages with no server", () => {
    expect(lspLanguageFor("README.md")).toBeNull();
    expect(lspLanguageFor("package.json")).toBeNull();
    expect(lspLanguageFor("notes.txt")).toBeNull();
  });
});

describe("lspServerName", () => {
  it("names the binary behind each language", () => {
    expect(lspServerName("rust")).toBe("rust-analyzer");
    expect(lspServerName("typescript")).toBe("typescript-language-server");
    expect(lspServerName("typescriptreact")).toBe("typescript-language-server");
    expect(lspServerName("javascript")).toBe("typescript-language-server");
    expect(lspServerName("python")).toBe("pyright-langserver");
  });

  it("falls back to the language id for anything unserved", () => {
    expect(lspServerName("json")).toBe("json");
  });
});
