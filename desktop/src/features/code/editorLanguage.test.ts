// monacoLanguageFor is the editor's only pure logic — the path→language guess — so it carries
// the swap's unit-test weight. The mapping must stay in lockstep with the CodeMirror
// `languageFor` it replaced (same extensions, same case-insensitivity, plaintext for unknown).
import { describe, expect, it } from "vitest";
import { monacoLanguageFor } from "./editorLanguage";

describe("monacoLanguageFor", () => {
  it("splits the old javascript mode into real typescript/javascript ids", () => {
    expect(monacoLanguageFor("src/App.tsx")).toBe("typescript");
    expect(monacoLanguageFor("lib/x.ts")).toBe("typescript");
    expect(monacoLanguageFor("hooks/use.mts")).toBe("typescript");
    expect(monacoLanguageFor("src/main.jsx")).toBe("javascript");
    expect(monacoLanguageFor("out/cli/index.js")).toBe("javascript");
    expect(monacoLanguageFor("config/run.mjs")).toBe("javascript");
  });

  it("maps the same extensions the CodeMirror languageFor did", () => {
    expect(monacoLanguageFor("crates/hub/src/lib.rs")).toBe("rust");
    expect(monacoLanguageFor("README.md")).toBe("markdown");
    expect(monacoLanguageFor("notes.markdown")).toBe("markdown");
    expect(monacoLanguageFor("scripts/train.py")).toBe("python");
    expect(monacoLanguageFor("package.json")).toBe("json");
    expect(monacoLanguageFor("pnpm-lock.yaml.lock")).toBe("json");
  });

  it("is case-insensitive on the extension", () => {
    expect(monacoLanguageFor("README.MD")).toBe("markdown");
    expect(monacoLanguageFor("Main.TS")).toBe("typescript");
  });

  it("gives unknown extensions plaintext, not a wrong guess", () => {
    expect(monacoLanguageFor("Makefile")).toBe("plaintext");
    expect(monacoLanguageFor("assets/logo.svg")).toBe("plaintext");
    expect(monacoLanguageFor("hub.mjs.bak")).toBe("plaintext");
  });
});
