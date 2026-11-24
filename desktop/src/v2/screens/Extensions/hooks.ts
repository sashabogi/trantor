// Debounced live search and per-selection detail loading for the Extensions screen (#13993).
import { useEffect, useState } from "react";
import { fetchDetail, fetchReadme, searchOpenVsx, type Ext, type ExtDetail, type SearchResult, type SortKey } from "./openvsx";

export const DEBOUNCE_MS = 300;

export type SearchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SearchResult };

export function useOpenVsxSearch(query: string, sort: SortKey, enabled: boolean): SearchState {
  const [state, setState] = useState<SearchState>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      searchOpenVsx(query.trim(), sort, ctl.signal)
        .then(data => setState({ status: "ready", data }))
        .catch((err: Error) => {
          if (ctl.signal.aborted) return;
          setState({ status: "error", message: err.message || "Open VSX could not be reached" });
        });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [query, sort, enabled]);
  return state;
}

export type DetailState = { detail: ExtDetail | null; readme: string | null; error: string | null };

export function useExtDetail(ext: Ext | null): DetailState {
  const [state, setState] = useState<DetailState>({ detail: null, readme: null, error: null });
  useEffect(() => {
    setState({ detail: null, readme: null, error: null });
    if (!ext) return;
    const ctl = new AbortController();
    fetchDetail(ext, ctl.signal)
      .then(detail => {
        setState({ detail, readme: null, error: null });
        if (!detail.readmeUrl) return;
        fetchReadme(detail.readmeUrl, ctl.signal)
          .then(readme => setState(s => ({ ...s, readme })))
          .catch(() => { /* a missing README leaves the facts box intact */ });
      })
      .catch((err: Error) => {
        if (!ctl.signal.aborted) setState({ detail: null, readme: null, error: err.message || "Details unavailable" });
      });
    return () => ctl.abort();
  }, [ext]);
  return state;
}
