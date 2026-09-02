// The language-server protocol shapes we read off the wire, pure and Tauri/monaco-free so the
// progress/phase logic is unit-testable without booting the bridge.

/** The `$/progress` notification shape, narrowed to what we read. */
export type ProgressProbe = {
  method?: string;
  params?: { token?: string | number; value?: { kind?: string; title?: string } };
};

export type ProgressEvent = { kind: string; title: string | null; token: string };

/** The "ready" token: rust-analyzer 1.94 ends with "rustAnalyzer/cachePriming" (older versions
 *  had "rustAnalyzer/Indexing"). Fetching/Roots Scanned/proc-macros end first and are NOT ready. */
export function isReadyToken(token: string | number | undefined): boolean {
  const t = token == null ? "" : String(token);
  return /index|priming/i.test(t);
}

/** Extract the progress event if this is a `$/progress` notification, else null. */
export function progressEvent(msg: ProgressProbe): ProgressEvent | null {
  if (msg.method !== "$/progress") return null;
  const params = msg.params;
  if (!params) return null;
  return {
    kind: params.value?.kind ?? "",
    title: params.value?.title ?? null,
    token: params.token == null ? "" : String(params.token),
  };
}
