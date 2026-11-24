// What the Explorer tree reads: the lazy per-folder listing, the git status for the same checkout, and the
// folders the operator left open (#13987 drill).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { projectFiles, type FileEntry } from "../../features/code/fileApi";
import { scopePanel } from "../screens/Code/scopeGitApi";
import { rollUp, type FolderMark, type GitPath } from "./explorerStatus";

const POLL_MS = 10_000;
export type Row = { entry: FileEntry; depth: number };
export type Counts = { plus: number | null; minus: number | null };
type Git = { status: GitPath[]; counts: Map<string, Counts> };

const expandedKey = (project: string, seat: string | null) => `trantor.v2.explorer.expanded.${project}.${seat ?? "project"}`;
function readExpanded(key: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

/** The visible rows in order: a folder's children follow it only while it is expanded and loaded. */
export function flatten(roots: FileEntry[], kids: Record<string, FileEntry[]>, expanded: string[]): Row[] {
  const out: Row[] = [];
  const walk = (list: FileEntry[], depth: number) => {
    for (const entry of list) {
      out.push({ entry, depth });
      if (entry.dir && expanded.includes(entry.path)) walk(kids[entry.path] ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

export type ExplorerData = {
  roots: FileEntry[] | null;
  error: string | null;
  rows: Row[];
  expanded: string[];
  toggle: (path: string) => void;
  expand: (path: string) => void;
  refresh: () => void;
  gitStatus: Map<string, { x: string; y: string }>;
  counts: Map<string, Counts>;
  folders: Map<string, FolderMark>;
};

export function useExplorerData(project: string, seat: string | null): ExplorerData {
  const key = expandedKey(project, seat);
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [kids, setKids] = useState<Record<string, FileEntry[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>(() => readExpanded(key));
  const [git, setGit] = useState<Git | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadDir = useCallback(async (dir: string) => {
    const list = await projectFiles(project, dir, seat ?? undefined).catch(() => null);
    if (list && alive.current) setKids(prev => ({ ...prev, [dir]: list }));
  }, [project, seat]);

  const refresh = useCallback(() => {
    projectFiles(project, undefined, seat ?? undefined)
      .then(r => { if (alive.current) { setRoots(r); setError(null); } })
      .catch(e => { if (alive.current) setError(e instanceof Error ? e.message : String(e)); });
    for (const dir of expandedRef.current) void loadDir(dir);
    // A failed git read just leaves the plain listing codes in charge: the tree must still render.
    scopePanel(project, seat, 1).then(p => {
      if (alive.current) setGit({ status: p.status, counts: new Map(p.counts.map(c => [c.path, { plus: c.plus, minus: c.minus }])) });
    }).catch(() => { if (alive.current) setGit(null); });
  }, [project, seat, loadDir]);

  useEffect(() => {
    refresh();
    const unlisten = listen<{ project: string }>("file-changed", ev => { if (ev.payload.project === project) refresh(); });
    const iv = setInterval(refresh, POLL_MS);
    return () => { clearInterval(iv); unlisten.then(u => u()).catch(() => {}); };
  }, [refresh, project]);

  const persist = useCallback((next: string[]) => {
    setExpanded(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage blocked: folders stay open for the session */ }
  }, [key]);
  const expand = useCallback((path: string) => {
    if (expandedRef.current.includes(path)) return;
    persist([...expandedRef.current, path]);
    void loadDir(path);
  }, [persist, loadDir]);
  const toggle = useCallback((path: string) => {
    if (expandedRef.current.includes(path)) persist(expandedRef.current.filter(p => p !== path));
    else expand(path);
  }, [persist, expand]);

  const rows = useMemo(() => flatten(roots ?? [], kids, expanded), [roots, kids, expanded]);
  const gitStatus = useMemo(() => new Map((git?.status ?? []).map(s => [s.path, { x: s.x, y: s.y }])), [git]);
  const folders = useMemo(() => rollUp(git?.status ?? []), [git]);
  return { roots, error, rows, expanded, toggle, expand, refresh, gitStatus, counts: git?.counts ?? new Map(), folders };
}
