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
//   2. Signing AND transport both happen in RUST. The key lives in ~/.agent-bus/keys/*.json and the
//      webview never sees it — nor a signature, nor even a header, only JSON. That was forced as well
//      as chosen: macOS App Transport Security blocks cleartext HTTP from WKWebView, so fetch() to a
//      hub on http://<tailnet>:4477 fails with an opaque "Load failed" that CSP cannot waive.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Scope = { project: string; role: "read" | "write" | "owner" };

export type Card = {
  id: number; project: string; title: string; status: string;
  assignee?: string; source?: string; difficulty?: string; model?: string;
  phase?: string; costUsd?: number; created?: number; updated?: number;
  /** the narrative line ("assigned — did"), written by the cheap summarizer */
  summary?: string;
};

export type HubEvent = {
  id?: number; ts: number; type: string; project?: string;
  by?: string; taskId?: number; [k: string]: unknown;
};

export type Message = {
  id: number; ts: number; from: string; to: string;
  project?: string; text: string; refs?: number[];
};

export type Peer = {
  session: string; project?: string; status?: string;
  lastSeen?: number; online?: boolean; hookVersion?: string;
  llm?: string; model?: string;
};

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
   * One card's FULL story: the card, its status events, and the bus messages that reference it
   * (#<id>) — the agent's own reports of what it did and why. Backs the detail drawer.
   */
  card(id: number) {
    return this.request<{ task: Card | null; events: HubEvent[]; messages: Message[] }>("GET", `/card?id=${id}`);
  }

  /**
   * The brain's books: Scrooge ledger windows (real spend + frontier-yardstick savings) and
   * card-based costs. NOTIONAL (plan-covered Claude work) stays strictly separate from REAL spend —
   * summing them would imply we paid for plan-covered tokens. Ledger sections are empty on a hub
   * whose machine has no Scrooge ledger (the remote hub); card costs work everywhere.
   */
  economics() { return this.request<Economics>("GET", "/economics"); }

  /** The self-learning loop: relay lessons, per-agent reliability, per-model economics + guardrails. */
  learning() { return this.request<Learning>("GET", "/learning"); }

  /** Cross-session batons: who handed off what, where, and why. */
  handoffs(project?: string) {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    return this.request<{ handoffs: Handoff[] }>("GET", `/handoffs${q}`).then(r => r.handoffs ?? []);
  }

  /** Live file claims — which session is touching which file, right now. */
  claims(project?: string) {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    return this.request<{ claims: FileClaim[] }>("GET", `/claims${q}`).then(r => r.claims ?? []);
  }

  /** The autonomy ladder (PRD §6): levels per project + declared codependency links. */
  policy() {
    return this.request<{ autonomy: Record<string, number>; links: { projects: string[]; reason: string }[] }>("GET", "/policy");
  }
  setAutonomy(project: string, level: number) {
    return this.request("POST", "/policy", { autonomy: { [project]: level } });
  }

  /**
   * Provider balances/quotas/subscriptions, server-scoped to the operator's configured profile.
   * MACHINE-LOCAL by nature (profile.json + the crew's own balance snapshots live on this machine),
   * so callers should ask the local hub.
   */
  balances() { return this.request<BalancesReport>("GET", "/balances"); }

  /**
   * Messages addressed to `session`. peek=1 reads WITHOUT advancing the delivery ledger — the app is
   * a viewer here, and marking a message delivered because a human glanced at a list would hide it
   * from the session's own hooks, which are the thing that actually acts on it.
   */
  inbox(session: string, since = 0) {
    const q = `?session=${encodeURIComponent(session)}&since=${since}&peek=1`;
    return this.request<{ messages: Message[]; cursor: number }>("GET", `/inbox${q}`);
  }
  send(to: string, text: string, project?: string) {
    return this.request<{ ok: boolean; id: number }>("POST", "/send", { to, text, project });
  }

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
  /**
   * Live event stream, fed by RUST (see identity.rs::stream).
   *
   * EventSource was never an option — it cannot send our four auth headers. The fetch+ReadableStream
   * version that replaced it then hit macOS App Transport Security, which blocks cleartext HTTP from
   * the webview and cannot be waived by CSP. So frame parsing, reconnect, backoff and `since` resume
   * all live in Rust, and the webview just receives parsed JSON on a Tauri event.
   */
  streamEvents(onEvent: (e: HubEvent) => void, onOpen?: () => void) {
    let unlisten: (() => void) | undefined;
    let stopped = false;
    void (async () => {
      unlisten = await listen<string>("hub-event", ev => {
        if (stopped) return;
        try { onEvent(JSON.parse(ev.payload) as HubEvent); } catch { /* a bad frame must not kill the feed */ }
      });
      await invoke("start_stream", { base: this.baseUrl });
      onOpen?.();   // connected — distinct from "an event arrived", which may be much later on an idle project
    })();
    return () => { stopped = true; unlisten?.(); };
  }
}

export type EconWindow = {
  calls: number; tokens_in: number; tokens_out: number;
  cost_usd: number; opus_equiv_usd: number; saved_usd: number;
};
export type Economics = {
  windows?: Record<string, EconWindow>;
  costKinds?: Record<string, Record<string, { count: number; usd: number | null }>>;
  notionalByProject?: Record<string, number>;
};

export type LessonRec = { text: string; scope: string; by: string; project?: string; ts: number };
export type LearningAgent = {
  agent: string; turns: number; failures: number; failRate: number;
  models: string[]; lastFailure?: { ts: number; exit: number; project: string } | null;
};
export type LearningModel = { model: string; guardrailCount: number; calls: number; cost_usd: number; saved_usd: number };
export type Learning = {
  totals: { lessons: number; guardrails: number; turns: number; failures: number; failRate: number; models: number };
  lessons: { global: LessonRec[]; byAgent: Record<string, LessonRec[]>; byProject: Record<string, LessonRec[]>; projects: string[] };
  agents: LearningAgent[]; agentsByProject: Record<string, LearningAgent[]>;
  models: LearningModel[]; modelsByProject: Record<string, LearningModel[]>;
};

export type BalanceEntry = {
  provider: string; label?: string;
  kind: "prepaid" | "quota" | "subscription";
  ok: boolean; low: boolean;
  remaining?: number | null; currency?: string;
  remainingPct?: number | null; plan?: string;
};
export type BalancesReport = { ts: number; entries: BalanceEntry[]; lowCount: number; stale: boolean };

export type Handoff = { project: string; session: string; ts: number; trigger?: string; id?: string };
export type FileClaim = { project: string; file: string; session: string; ts: number; agoSec: number };

export class HubAuthError extends Error {}

/** A project resolves to exactly one hub (TDD §12.1) — the mapping comes from Rust. */
export async function hubForProject(project: string): Promise<string> {
  return invoke<string>("hub_for_project", { project });
}
export type DoctorEntry = { section: string; message: string; fix?: string | null };
export type DoctorReport = {
  sections: string[]; ok: DoctorEntry[]; issues: DoctorEntry[];
  notes: DoctorEntry[]; issueCount: number;
};

/** Harness detection, from the SAME engine `trantor doctor` uses. */
export async function doctor(): Promise<DoctorReport> {
  return JSON.parse(await invoke<string>("doctor"));
}

export async function knownProjects(): Promise<string[]> {
  return invoke<string[]>("known_projects");
}

export type CardCode = {
  dir: string | null;
  files: string[];
  commits: { sha: string; subject: string }[];
  origin: string | null;
};

/** The card→code link, resolved on THIS machine (repos live here, hubs don't have them). */
export async function cardCode(project: string, cardId: number, candidates: string[]): Promise<CardCode> {
  return JSON.parse(await invoke<string>("card_code", { project, cardId, candidates }));
}

/** Open a file/url the way the operator prefers (Settings → "Open code in"). */
export async function openCode(target: string, kind: "url" | "path" | "reveal" = "path"): Promise<void> {
  return invoke("open_code", { target, kind });
}

export type EditorPref = "default" | "vscode" | "cursor" | "zed" | "reveal";
export function editorPref(): EditorPref {
  try { return (localStorage.getItem("tr.editor") as EditorPref) || "default"; } catch { return "default"; }
}
export function setEditorPref(v: EditorPref) { try { localStorage.setItem("tr.editor", v); } catch {} }
export function openFileInEditor(absPath: string) {
  const pref = editorPref();
  if (pref === "vscode") return openCode(`vscode://file${absPath}`, "url");
  if (pref === "cursor") return openCode(`cursor://file${absPath}`, "url");
  if (pref === "zed")    return openCode(`zed://file${absPath}`, "url");
  if (pref === "reveal") return openCode(absPath, "reveal");
  return openCode(absPath, "path");
}
