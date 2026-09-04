// The #5857 acceptance drill, run in the REAL webview: `TRANTOR_LSP_DRILL=<spec>` makes the
// Rust shell emit `lsp-drill` after boot (src-tauri/src/lib.rs setup), and this drives the exact
// editor path — startLsp, trackDocument, an edit, a completion — with no UI clicking. The
// evidence lands in the wire trace (~/.agent-bus/lsp/rust-*.trace: initialized, didOpen,
// didChange, completion in AND out) and the narrative in app-trace.log.
//
// #6311: <spec> is a list of legs "project[:path]" joined by ">". One leg runs the original
// drill for that project; two or more legs STOP each project's servers (stopLspProject — the
// real project-switch path) before starting the next, and the LAST leg is held PAST the 30s
// start cap and probed with a second completion — the proof that a switch-back server that
// answered initialize is never stopped by the cap (0.3.134's uncancelled cap timer killed it).
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { isLspIndexing, isLspLive, startLsp, stopLspProject } from "./lspClient";
import { attachOpenDocuments, trackDocument } from "./lspDocuments";
import { trackedLspCompletion } from "./completionActivity";
import { lspLanguageFor } from "./lspLanguage";
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

/** Start the (project, path) leg's server, open its model, and fire one completion — the wire
 *  trace must show it in AND out. Returns when the server is ready; throws on failure. */
async function startAndComplete(project: string, path: string, tag: string): Promise<void> {
  log(`${tag}: start project=${project} path=${path}`);
  const language = lspLanguageFor(path);
  if (!language) throw new Error(`no server for ${path}`);
  const started = await startLsp(project, null, language, path);
  log(`${tag}: client running wsRoot=${started.workspaceRoot}`);
  const body = await readFile(project, path);
  const uri = monaco.Uri.file(`${started.scopeRoot}/${path}`);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(body.text, language, uri);
  trackDocument(model, language);
  attachOpenDocuments();
  log(`${tag}: didOpen sent for ${String(uri)}`);

  if (!(await waitReady(language, started.workspaceRoot))) {
    throw new Error(`${tag}: server never reached ready within 300s`);
  }
  log(`${tag}: server ready (indexing done)`);
  await fireCompletion(model, language, tag);
}

/** An edit + completion request on the leg's model — the completion is the wire proof. */
async function fireCompletion(model: monaco.editor.ITextModel, language: string, tag: string): Promise<void> {
  const lastLine = model.getLineCount();
  const lastCol = model.getLineMaxColumn(lastLine);
  // A trailing comment is a legal edit in every served language and dirties nothing structural.
  model.applyEdits([{
    range: { startLineNumber: lastLine, startColumn: lastCol, endLineNumber: lastLine, endColumn: lastCol },
    text: `\n// lsp-drill ${tag} ${Date.now()}\n`,
  }]);
  const line = model.getLineCount();
  const col = model.getLineMaxColumn(line);
  const result = await trackedLspCompletion(String(model.uri), language, line, col);
  // The completion payload is either a bare array or { items }; decode both to an item list.
  const items = Array.isArray(result) ? result : (result?.items ?? []);
  const labels = items.slice(0, 8).map(i => i.label ?? "?");
  log(`${tag}: completion items=${items.length} first=[${labels.join(", ")}]`);
}

export async function runLspDrill(spec: string, path = "desktop/src-tauri/src/lib.rs"): Promise<void> {
  const legs = spec.split(">").map((leg) => {
    const i = leg.indexOf(":");
    return i < 0 ? { project: leg, path } : { project: leg.slice(0, i), path: leg.slice(i + 1) };
  });
  try {
    const legT0 = Date.now();
    await startAndComplete(legs[0].project, legs[0].path, "leg1");
    await drillRemount(legs[0].project, legs[0].path);

    for (let n = 1; n < legs.length; n++) {
      log(`switch: stopping ${legs[n - 1].project} servers, switching to ${legs[n].project}`);
      await stopLspProject(legs[n - 1].project);
      await startAndComplete(legs[n].project, legs[n].path, `leg${n + 1}`);
    }

    if (legs.length > 1) {
      // The #6311 money proof: 0.3.134's uncancelled start cap killed every healthy server at
      // +30s after its start began. Hold past that deadline and fire another completion — a
      // live answer means a switch-back server that answered initialize survived the cap.
      const last = legs[legs.length - 1];
      const language = lspLanguageFor(last.path);
      if (!language) throw new Error(`no server for ${last.path}`);
      await startLsp(last.project, null, language, last.path);
      const holdMs = Math.max(0, legT0 + 35_000 - Date.now());
      log(`cap survival: holding ${last.project} for ${holdMs}ms more (past the 30s start cap)`);
      await new Promise(r => setTimeout(r, holdMs));
      const started = await startLsp(last.project, null, language, last.path);
      const uri = monaco.Uri.file(`${started.scopeRoot}/${last.path}`);
      const model = monaco.editor.getModel(uri);
      if (!model) throw new Error(`cap survival: no model for ${String(uri)}`);
      log("cap survival: server still live past the 30s cap — firing the final completion");
      await fireCompletion(model, language, "cap-survival");
    }
    log("done");
  } catch (e) {
    log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The Workspace -> Code remount path for the FIRST leg: the editor and its model go away, then
 *  the SAME host receives a new model created from storedDraft. The drill uses a private store
 *  scope so it cannot dirty the operator's open project tab. */
async function drillRemount(project: string, path: string): Promise<void> {
  const started = await startLsp(project, null, lspLanguageFor(path) ?? "rust", path);
  const body = await readFile(project, path);
  const uri = monaco.Uri.file(`${started.scopeRoot}/${path}`);
  const model = monaco.editor.getModel(uri);
  if (!model) { log(`remount: no model for ${String(uri)}`); return; }
  model.dispose();

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
}
