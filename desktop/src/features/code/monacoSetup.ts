// The Monaco wiring, modeled on Orca's monaco-setup.ts (the local-bundling contract): LOCAL, never
// CDN (vite `?worker` imports, MonacoEnvironment.getWorker per language); TS/JS language services
// MUTED (an editor that cannot resolve imports raises false errors; tokenization stays); JSX needs
// Preserve or TS17004 fires; ONE theme, `trantor-calm`, from the palette in src/styles.css.
import * as monaco from "monaco-editor";
import { typescript as monacoTS } from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// SAFETY: MonacoEnvironment is monaco's documented global hook and globalThis carries no type
// for it; the value assigned is a monaco.Environment, so the assertion only names the one key.
(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true,
};
monacoTS.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
monacoTS.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);

monacoTS.typescriptDefaults.setCompilerOptions({
  ...monacoTS.typescriptDefaults.getCompilerOptions(),
  jsx: monacoTS.JsxEmit.Preserve,
});
monacoTS.javascriptDefaults.setCompilerOptions({
  ...monacoTS.javascriptDefaults.getCompilerOptions(),
  jsx: monacoTS.JsxEmit.Preserve,
});

// The palette (styles.css): bg #131316, panel #1e1e22, edge #2a2a30, text #ececf0,
// muted #9a9aa3, ok #14b8a6, doing #4a90d9, fail #ef6a6a, warn #d9a441.
monaco.editor.defineTheme("trantor-calm", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "ececf0" },
    { token: "comment", foreground: "9a9aa3", fontStyle: "italic" },
    { token: "string", foreground: "d9a441" },
    { token: "string.escape", foreground: "ececf0" },
    { token: "keyword", foreground: "4a90d9" },
    { token: "keyword.json", foreground: "4a90d9" },
    { token: "number", foreground: "14b8a6" },
    { token: "type", foreground: "14b8a6" },
    { token: "type.identifier", foreground: "14b8a6" },
    { token: "delimiter", foreground: "9a9aa3" },
    { token: "tag", foreground: "4a90d9" },
    { token: "attribute.name", foreground: "d9a441" },
    { token: "attribute.value", foreground: "14b8a6" },
    { token: "regexp", foreground: "ef6a6a" },
  ],
  colors: {
    "editor.background": "#131316",
    "editor.foreground": "#ececf0",
    "editorGutter.background": "#131316",
    // muted/edge faded, not new colors
    "editorLineNumber.foreground": "#6f6f78",
    "editorLineNumber.activeForeground": "#9a9aa3",
    "editor.lineHighlightBackground": "#2a2a3055",
    "editor.selectionBackground": "#4a90d933",
    "editorIndentGuide.background1": "#2a2a30",
    "editorWidget.background": "#1e1e22",
    "editorWidget.border": "#2a2a30",
    "editorBracketMatch.background": "#4a90d922",
    "editorBracketMatch.border": "#4a90d966",
    "diffEditor.insertedTextBackground": "#14b8a622",
    "diffEditor.removedTextBackground": "#ef6a6a22",
    "diffEditor.insertedLineBackground": "#14b8a614",
    "diffEditor.removedLineBackground": "#ef6a6a14",
    "scrollbarSlider.background": "#2a2a30aa",
    "scrollbarSlider.hoverBackground": "#2a2a30",
  },
});

export { monaco };
