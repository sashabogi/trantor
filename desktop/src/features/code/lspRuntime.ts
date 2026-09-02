// The BROWSER-ONLY half of lspClient's seams: real monaco-languageclient + the monaco-vscode-api.
// This module imports monaco, which cannot load in a node test (CSS imports), so lspClient.ts
// never imports it statically — the DEFAULT deps dynamic-import this file only when a client
// actually starts in the app. lspClient.test.ts injects an in-memory bus + fake client instead.
import { MonacoLanguageClient } from "monaco-languageclient";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import { Uri } from "vscode";
import "./monacoSetup";
import type { MessageTransports } from "vscode-languageclient/browser.js";
import type { LspClientDeps, LspClientLike } from "./lspClient";

let servicesPromise: Promise<void> | null = null;

/** Start the monaco-vscode-api once, ever (lspClient's ensureServices). */
export async function ensureServices(): Promise<void> {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const apiWrapper = new MonacoVscodeApiWrapper({
        $type: "classic",
        viewsConfig: { $type: "EditorService" },
      });
      await apiWrapper.start();
    })();
  }
  return servicesPromise;
}

function workspaceFolderUri(path: string) {
  return Uri.file(path);
}

/** Build a REAL MonacoLanguageClient over the given transports. */
export function makeClient(opts: {
  name: string; id: string; workspaceRoot: string; project: string; transports: MessageTransports;
}): LspClientLike {
  const documentSelector = [opts.id.slice(opts.id.indexOf("\u0000") + 1)];
  // SAFETY: MonacoLanguageClient satisfies the LspClientLike slice (start/stop + the jsonrpc wire
  // methods the document sync uses) and is the only concrete client the app constructs; the cast
  // narrows it to that structural contract, never to a different type.
  return new MonacoLanguageClient({
    id: opts.id,
    name: opts.name,
    clientOptions: {
      documentSelector,
      workspaceFolder: { uri: workspaceFolderUri(opts.workspaceRoot), name: opts.project, index: 0 },
    },
    messageTransports: opts.transports,
  }) as LspClientLike;
}

/** The real browser deps: tauri (node-safe) + the lazy monaco runtime above. */
export async function realLspDeps(): Promise<LspClientDeps> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const bus: LspClientDeps["bus"] = {
    invoke: <T,>(cmd: "lsp_send", args: { id: number; message: string }) => invoke<T>(cmd, args),
    // SAFETY: tauri listen's Event<T> payload container is wider than the { payload } slice the
    // reader reads; passing the narrower handler through is safe — only .payload is consumed.
    listen: ((event: Parameters<typeof listen>[0], handler: Parameters<typeof listen>[1]) => listen(event, handler)) as NonNullable<LspClientDeps["bus"]>["listen"],
  };
  // SAFETY: lsp_stop/lsp_stop_project are fire-and-forget — the hub/runtime resolves them with no
  // useful body, so typing the invoke result as void loses nothing the caller reads.
  const stopServer: (id: number) => Promise<void> = (id) => invoke("lsp_stop", { id }) as Promise<void>;
  // SAFETY: lsp_stop_project is fire-and-forget — see stopServer above.
  const stopProjectServer: (project: string) => Promise<void> = (project) => invoke("lsp_stop_project", { project }) as Promise<void>;
  return {
    startServer: (args) => invoke<{ id: number; scopeRoot: string; workspaceRoot: string; initialized: boolean }>("lsp_start", args),
    stopServer,
    stopProjectServer,
    bus,
    fileUri: (path) => workspaceFolderUri(path),
    ensureServices,
    makeClient,
  };
}
