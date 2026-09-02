// The #5857 acceptance drill, run in the REAL webview: `TRANTOR_LSP_DRILL=<project>` makes the
// Rust shell emit `lsp-drill` after boot (src-tauri/src/lib.rs setup), and this drives the exact
// editor path — startLsp, trackDocument, an edit, a completion — with no UI clicking. The
// evidence lands in the wire trace (~/.agent-bus/lsp/rust-*.trace: initialized, didOpen,
// didChange, completion in AND out) and the narrative in app-trace.log.
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { isLspIndexing, isLspLive, startLsp } from "./lspClient";
import { attachOpenDocuments, trackDocument } from "./lspDocuments";
import { trackedLspCompletion } from "./completionActivity";
import { readFile } from "./fileApi";
import { setDraft, storedDraft } from "./documents";

function log(line: string): void {
  invoke("app_log", { line: `lsp-drill ${line}` }).catch(() => {});
}

type SuggestController = {
  dispose(): void;
  model?: { state?: number };
  widget?: { value?: { _state?: number } };
};

function suggestState(editor: monaco.editor.IStandaloneCodeEditor, host: HTMLElement): string {
  const controller = editor.getContribution<SuggestController>("editor.contrib.suggestController");
  const widgetState = controller?.widget?.value?._state ?? -1;
  const visible = !!host.querySelector(".suggest-widget.visible");
  const layout = editor.getLayoutInfo();
  return `model=${controller?.model?.state ?? -1} widget=${widgetState} visible=${visible} layout=${layout.width}x${layout.height}`;
}

async function waitForSuggest(editor: monaco.editor.IStandaloneCodeEditor, host: HTMLElement): Promise<string> {
  const deadline = Date.now() + 5_000;
  let state = suggestState(editor, host);
  while (Date.now() < deadline) {
    if (state.includes("visible=true")) return state;
    await new Promise(r => setTimeout(r, 50));
    state = suggestState(editor, host);
  }
  return state;
}

/** Poll until the server is live AND past its indexing phase. The 300s cap is the drill cap the
 *  readiness work set — a drill that hangs forever is a drill that never reports. */
async function waitReady(language: string, wsRoot: string): Promise<boolean> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (isLspLive(language, wsRoot) && !isLspIndexing(language, wsRoot)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export async function runLspDrill(project: string, path = "desktop/src-tauri/src/lib.rs"): Promise<void> {
  try {
    log(`start project=${project} path=${path}`);
    const started = await startLsp(project, null, "rust", path);
    log(`client running wsRoot=${started.workspaceRoot}`);
    const body = await readFile(project, path);
    const uri = monaco.Uri.file(`${started.scopeRoot}/${path}`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(body.text, "rust", uri);
    trackDocument(model, "rust");
    attachOpenDocuments();
    log(`didOpen sent for ${String(uri)}`);

    if (!(await waitReady("rust", started.workspaceRoot))) {
      log("FAILED: server never reached ready within 300s");
      return;
    }
    log("server ready (indexing done)");

    // Type `std::` into a scratch fn at the end of the file — the edit fires didChange, then the
    // completion request rides the same document.
    const lastLine = model.getLineCount();
    const lastCol = model.getLineMaxColumn(lastLine);
    model.applyEdits([{
      range: { startLineNumber: lastLine, startColumn: lastCol, endLineNumber: lastLine, endColumn: lastCol },
      text: "\nfn lsp_drill() { let _ = std::; }\n",
    }]);
    const line = lastLine + 1;
    const col = "fn lsp_drill() { let _ = std::".length + 1; // just past the second `:`
    const result = await trackedLspCompletion(String(model.uri), "rust", line, col);
    const items = Array.isArray(result) ? result : (result?.items ?? []);
    const labels = items.slice(0, 8).map(i => i.label ?? "?");
    log(`completion items=${items.length} first=[${labels.join(", ")}]`);
    model.dispose();

    // Reproduce the Workspace -> Code path, not merely the protocol path above: the first editor
    // and its model go away, then the SAME host receives a new model created from storedDraft.
    // The drill uses a private store scope so it cannot dirty the operator's open project tab.
    const drillSeat = "__lsp-drill__";
    const drillKey = `${drillSeat}:${path}`;
    const drillText = `${body.text}\nfn lsp_remount_drill() { let _ = std::; }\n`;
    setDraft(project, drillKey, drillText);
    const host = document.createElement("div");
    host.dataset.lspDrill = "remount";
    Object.assign(host.style, {
      position: "fixed",
      inset: "48px",
      zIndex: "2147483647",
      background: "#101013",
    });
    document.body.append(host);
    const createEditor = () => {
      const nextModel = monaco.editor.createModel(
        storedDraft(project, drillSeat, path) ?? body.text,
        "rust",
        uri,
      );
      trackDocument(nextModel, "rust");
      attachOpenDocuments();
      const editor = monaco.editor.create(host, {
        model: nextModel,
        automaticLayout: true,
        quickSuggestions: true,
        suggestOnTriggerCharacters: true,
      });
      return { editor, model: nextModel };
    };

    const first = createEditor();
    log(`remount first ${suggestState(first.editor, host)}`);
    first.editor.dispose();
    first.model.dispose();

    const remounted = createEditor();
    const remountLine = remounted.model.getLineCount() - 1;
    const remountColumn = "fn lsp_remount_drill() { let _ = std::".length + 1;
    remounted.editor.setPosition({ lineNumber: remountLine, column: remountColumn });
    remounted.editor.focus();
    log(`remount before-trigger ${suggestState(remounted.editor, host)}`);
    remounted.editor.trigger("lsp-drill", "editor.action.triggerSuggest", null);
    log(`remount after-trigger ${await waitForSuggest(remounted.editor, host)}`);
    remounted.editor.dispose();
    remounted.model.dispose();
    host.remove();
    log("done");
  } catch (e) {
    log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}
