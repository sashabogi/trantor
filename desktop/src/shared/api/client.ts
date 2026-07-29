// trantor desktop — THE CLIENT CONTRACT. Every view imports this; nothing else talks to a hub.
//
// Frozen the same way lib/identity.mjs and lib/store-contract.mjs were, and for the same reason: the
// views fan out against it, and contract drift between them is what actually costs a rebuild.
//
// WHY THIS FILE EXISTS AT ALL — the hub runs RELAY_AUTH=enforce, and every request needs four headers
// (x-trantor-pubkey / -sig / -ts / -nonce). Two consequences shape everything below:
//
//   1. `EventSource` CANNOT be used. The browser API accepts a URL and one boolean — it cannot set
//      headers, so it can never authenticate against our hub. That is exactly why the old ui.html
//      gets a 200 for the page and 401 for every data call. We therefore parse SSE ourselves from a
//      streaming fetch (decision: Option A — one auth mechanism, not two; a token-in-URL scheme would
//      have put secrets in logs and history AND added a second thing to get wrong).
//
//   2. Signing happens in RUST, never here. The private key lives in ~/.agent-bus/keys/*.json and the
//      webview must never see it. The TS side asks Tauri to sign a request description and gets back
//      headers. If we later move the whole stream into Rust (Option B), only this file changes.
import { invoke } from "@tauri-apps/api/core";

export type Scope = { project: string; role: "read" | "write" | "owner" };

export type Card = {
  id: number; project: string; title: string; status: string;
  assignee?: string; source?: string; difficulty?: string; model?: string;
  phase?: string; costUsd?: number; created?: number; updated?: number;
};

export type HubEvent = {
  id?: number; ts: number; type: string; project?: string;
  by?: string; taskId?: number; [k: string]: unknown;
};

export type Peer = {
  session: string; project?: string; status?: string;
  lastSeen?: number; online?: boolean; hookVersion?: string;
};

/** Rust returns the four signature headers for one request description. */
async function signHeaders(method: string, path: string, body?: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("sign_request", { method, path, body: body ?? null });
}

export class HubClient {
  constructor(readonly baseUrl: string) {}

  /** path MUST include the query string — it is part of what gets signed. */
  // Goes through RUST, not fetch(). macOS App Transport Security blocks cleartext HTTP from the
  // webview, so a hub on http://<tailnet>:4477 fails with an opaque "Load failed" that CSP cannot
  // fix. Routing via Rust also means the webview never handles a key or a signature — only JSON.
  private async request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const res = await invoke<{ status: number; body: string }>("hub_request", {
      base: this.baseUrl, method, path, body: body ?? null,
    });
    if (res.status === 401) throw new HubAuthError(`not enrolled on ${this.baseUrl}`);
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}`);
    return JSON.parse(res.body) as T;
  }

  tasks(project?: string) {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    return this.request<{ tasks: Card[] }>("GET", `/tasks${q}`).then(r => r.tasks ?? []);
  }
  peers()   { return this.request<{ peers: Peer[] }>("GET", "/peers").then(r => r.peers ?? []); }
  events(opts: { project?: string; type?: string; since?: number; limit?: number } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    return this.request<{ events: HubEvent[]; cursor?: number; latest?: number }>("GET", `/events${s ? "?" + s : ""}`);
  }
  moveCard(id: number, status: string) { return this.request("POST", "/task/update", { id, status }); }

  /**
   * Live event stream. Replaces EventSource, which cannot send our auth headers.
   *
   * Everything EventSource would have given for free — frame parsing, reconnect, backoff, resume —
   * is ours to implement, so it is all here rather than scattered across views:
   *   • frames are blocks separated by a blank line; we buffer because a chunk can split one in half
   *   • the hub emits a NAMED `event: ev` channel, so a plain onmessage consumer never sees it
   *   • reconnect uses exponential backoff, and resumes from the last id so nothing is missed
   * Returns an unsubscribe function.
   */
  streamEvents(onEvent: (e: HubEvent) => void, onState?: (s: "open" | "closed" | "retrying") => void) {
    let stop = false, retry = 0, lastId = 0;
    const ctrl = { abort: () => {} };

    const run = async () => {
      while (!stop) {
        const ac = new AbortController();
        ctrl.abort = () => ac.abort();
        try {
          const path = `/stream?events=1${lastId ? `&since=${lastId}` : ""}`;
          const headers = await signHeaders("GET", path);
          const res = await fetch(this.baseUrl + path, { headers, signal: ac.signal });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          onState?.("open");
          retry = 0;

          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (!stop) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let sep: number;
            // A chunk can end mid-frame, so only consume up to the last complete blank-line break.
            while ((sep = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, sep); buf = buf.slice(sep + 2);
              let name = "message", data = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) name = line.slice(6).trim();
                else if (line.startsWith("data:")) data += line.slice(5).trim();
                else if (line.startsWith("id:")) lastId = Number(line.slice(3).trim()) || lastId;
              }
              if (name !== "ev" || !data) continue;   // ignore keepalives and the legacy channel
              try {
                const ev = JSON.parse(data) as HubEvent;
                if (ev.id && ev.id > lastId) lastId = ev.id;
                onEvent(ev);
              } catch { /* a malformed frame must never kill the stream */ }
            }
          }
        } catch {
          if (stop) break;
          onState?.("retrying");
          // Backoff caps at 15s: a hub restart should reconnect quickly, a dead network shouldn't spin.
          await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** retry++, 15000)));
        }
      }
      onState?.("closed");
    };
    void run();
    return () => { stop = true; ctrl.abort(); };
  }
}

export class HubAuthError extends Error {}

/** A project resolves to exactly one hub (TDD §12.1) — the mapping comes from Rust. */
export async function hubForProject(project: string): Promise<string> {
  return invoke<string>("hub_for_project", { project });
}
export async function knownProjects(): Promise<string[]> {
  return invoke<string[]>("known_projects");
}
