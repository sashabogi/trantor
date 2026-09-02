// The #5857 acceptance drill, run in the REAL webview: `TRANTOR_LSP_DRILL=<project>` makes the
// Rust shell emit `lsp-drill` after boot (src-tauri/src/lib.rs setup), and this drives the exact
// editor path — startLsp, trackDocument, an edit, a completion — with no UI clicking. The
// evidence lands in the wire trace (~/.agent-bus/lsp/rust-*.trace: initialized, didOpen,
// didChange, completion in AND out) and the narrative in app-trace.log.
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { isLspIndexing, isLspLive, startLsp } from "./lspClient";
import { attachOpenDocuments, lspCompletion, trackDocument } from "./lspDocuments";
import { readFile } from "./fileApi";

function log(line: string): void {
  invoke("app_log", { line: `lsp-drill ${line}` }).catch(() => {});
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
    const result = await lspCompletion(String(model.uri), "rust", line, col);
    const items = Array.isArray(result) ? result : ((result as { items?: unknown[] } | null)?.items ?? []);
    const labels = items.slice(0, 8).map(i => (i as { label?: string }).label ?? "?");
    log(`completion items=${items.length} first=[${labels.join(", ")}]`);
    model.dispose();
    log("done");
  } catch (e) {
    log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}
