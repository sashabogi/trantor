// The graph view's bridge to `code_graph` (#7952): one command, file-level nodes and edges only,
// or `{error}` when graft is missing. The lens shows the error where the canvas would be.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { projectChanges, type ProjectChangeRow } from "../gitApi";

export type GraphNode = {
  id: string;
  name: string;
  cluster: string;
  chars: number;
  inDegree: number;
  outDegree: number;
  isTest: boolean;
  testedBy: number;
  orphan: boolean;
  doc: boolean;
  cycleId: number | null;
};

export type GraphEdge = { source: string; target: string; relation: "imports" | "calls" };

export type GraphMeta = { files: number; edges: number; externalTargets: number; cycles: number; buildMs: number };

export type CodeGraph = { root: string; nodes: GraphNode[]; edges: GraphEdge[]; meta: GraphMeta };

export type GraphError = { error: string };

export type CodeGraphResponse = CodeGraph | GraphError;

/** The exact string graft_cli.rs answers with when the binary is not on PATH. */
export const GRAFT_MISSING = "graft not installed";

export function isGraphError(response: CodeGraphResponse): response is GraphError {
  return "error" in response;
}

export async function codeGraph(project: string, seat?: string): Promise<CodeGraphResponse> {
  return JSON.parse(await invoke<string>("code_graph", { project, seat: seat ?? null }));
}

/** The watcher's batch (`file_watch` in lib.rs): paths relative to the main checkout, every 200ms. */
export type FileChangedPayload = { project: string; paths: string[] };

/** Subscribe to the project's `file-changed` batches; returns the unsubscribe. The watcher covers
 *  the main checkout only, so a seat scope has nothing to hear here (#7953, blueprint §2). */
export function watchFileChanges(project: string, onBatch: (paths: string[]) => void): () => void {
  let alive = true;
  const unlisten = listen<FileChangedPayload>("file-changed", ev => {
    if (!alive || ev.payload.project !== project) return;
    onBatch(ev.payload.paths);
  });
  return () => {
    alive = false;
    unlisten.then(u => u()).catch(() => {});
  };
}

/** What GraphView reads, as an object so a drill can hand it fixtures without module mocking. */
export type GraphApi = {
  graph: (project: string, seat?: string) => Promise<CodeGraphResponse>;
  changes: (project: string) => Promise<ProjectChangeRow[]>;
  fileChanges: (project: string, onBatch: (paths: string[]) => void) => () => void;
};

export const graphApi: GraphApi = { graph: codeGraph, changes: projectChanges, fileChanges: watchFileChanges };
