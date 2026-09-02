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
import { describeTransportFailure } from "./transport-errors";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Scope = { project: string; role: "read" | "write" | "owner" };

export type Card = {
  id: number; project: string; title: string; status: string;
  assignee?: string; source?: string; difficulty?: string; model?: string;
  /** The SIGNED identity that actually moved the card into doing/testing/done — evidence, where
   *  `assignee` is only intent. A card filed by the orchestrator and built by a seat wears the
   *  seat's face because of this field. */
  workedBy?: string;
  phase?: string; costUsd?: number; created?: number; updated?: number;
  /** Creation stamp as the hub serves it — tasks are born `ts === updated`, and the CARDLOG boot
   * backfill fills it for cards minted before it existed. The tile age badge reads `updated || ts`. */
  ts?: number;
  /** The card's STORY (CARDLOG contract): notes attached on /task + /task/update, capped 40
   * entries × 2000 chars hub-side, chronological oldest→newest. The drawer's primary block. */
  log?: { ts: number; by: string; text: string }[];
  /** the narrative line ("assigned — did"), written by the cheap summarizer */
  summary?: string;
  /** #5624: acceptance items — checked/total is the one honest denominator for a progress bar.
   * Absent or empty = no checklist, and the UI renders nothing (never fabricate progress). */
  checklist?: { text: string; done: boolean }[];
  /** Who POSTED the card — `${hostId()}:${project}`, the same shape a focus card's assignee has.
   * This, not `parent`, is what actually joins a sub-agent to the session that spawned it. */
  by?: string;
  /** The spawning session as Claude Code names it: a session UUID, NOT a bus session id. This is
   * the join key for nesting: it matches the `cc` of the focus card for that same Claude session. */
  parent?: string;
  /** FOCUS CARDS ONLY (source "session"): the Claude Code session UUID this card belongs to.
   * `assignee` is a bus id and is per host+project, so it cannot tell two Claude sessions in one
   * project apart; `cc` can, and it is what a sub-agent's `parent` joins to. Absent on cards
   * written by a client older than 0.17.70. */
  cc?: string;
  /** FOCUS CARDS: the git card whose commit closed this focus. */
  commitCard?: number;
  /** GIT CARDS: the focus card this commit closed. The pair links both ways, so the drawer can
   * walk from a commit to the session's work and back. */
  focusCard?: number;
  /** Sub-agent kind ("Explore", "general-purpose", …) — set by hooks/subagent-cost.mjs. */
  agentType?: string;
  /** Rolling count: the hub collapses repeat sub-agent runs into ONE card rather than minting dupes. */
  count?: number;
};

// Event payloads are heterogeneous by `type` — the fields below are named per the actual event
// kinds that carry them, instead of an open `[k: string]: unknown` index that gave every consumer
// license to read anything and cast its way there. Add a field here (not a cast at the call site)
// the next time a new event kind needs one.
export type HubEvent = {
  id?: number; ts: number; type: string; project?: string;
  by?: string; taskId?: number;
  /** message events */
  msgId?: number; text?: string; toSession?: string;
  /** card events: created / moved / updated */
  from?: string; to?: string; status?: string; title?: string;
  /** file.claim / file.conflict */
  file?: string; with?: string[];
  /** overseer.warn / verify.gate.* roll-up fields */
  kind?: string; detail?: string; claim?: string; narration?: string; files?: string[];
  /** proposal.filed */
  scope?: string;
  /** verify.gate.opened */
  reason?: string;
  /** overseer.warn / verify.gate.opened can carry the agents involved in the condition */
  sessions?: string[];
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

export type OverseerWarning = {
  project: string; kind: string; sessions: string[]; files: string[]; detail: string;
  /** When this episode STARTED — a standing condition is reported once and dated, not re-fired. */
  since?: number;
};
/** An agent-proposed permission (governance) — filed over the bus, decided ONLY by the human. */
export type Proposal = {
  id: number; session: string; project: string;
  /** The BOUND — all three are mandatory hub-side; an unbounded proposal never becomes a row. */
  scope: string; condition: string; exclusions: string;
  status: "pending" | "approved" | "denied" | "withdrawn";
  ts: number; decidedTs?: number; decidedBy?: string; note?: string;
};

export type OverseerStatus = {
  engine: boolean; lastTickTs: number; tickMs: number; clearMs: number; dutySession: string;
  watching: { sessions: number; projects: number; claims: number; links: number };
  autonomy: Record<string, number>;
  links: { projects: string[]; reason: string }[];
  warnings: OverseerWarning[];
  standing: number;
};

export type DutyHealth = {
  configured: boolean;
  online: boolean;
  lastSeenMs: number;
  darkSinceMs: number;
  queuedEscalations: number;
};

export type HubHealth = {
  ok: boolean;
  authMode: string;
  peers: number;
  messages: number;
  streams: number;
  duty?: DutyHealth;
};

export class HubClient {
  constructor(readonly baseUrl: string) {}

  /** path MUST include the query string — it is part of what gets signed. */
  // Goes through RUST, not fetch(). macOS App Transport Security blocks cleartext HTTP from the
  // webview, so a hub on http://<tailnet>:4477 fails with an opaque "Load failed" that CSP cannot
  // fix. Routing via Rust also means the webview never handles a key or a signature — only JSON.
  // P is inferred from whatever object literal each call site builds (e.g. `{ id, status }`) —
  // there is no one shape to name here, since this is the shared transport for every endpoint's
  // own already-typed request body.
  private async request<T, P = never>(method: string, path: string, payload?: P): Promise<T> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    let res: { status: number; body: string };
    try {
      res = await invoke<{ status: number; body: string }>("hub_request", {
        base: this.baseUrl, method, path, body: body ?? null,
      });
    } catch (e) {
      // The operator gets the translation; the console keeps the original, so translating a failure
      // never costs us the string a bug report needs.
      const raw = String(e);
      console.warn(`[trantor] hub transport failure on ${method} ${path}:`, raw);
      throw new HubTransportError(describeTransportFailure(raw, this.baseUrl), raw);
    }
    if (res.status === 401) throw new HubAuthError(`not enrolled on ${this.baseUrl}`);
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}`);
    // The return type carries the contract; JSON.parse's `any` result flows into it without a
    // cast the same way it already does for doctor()/cardCode() below.
    return JSON.parse(res.body);
  }

  tasks(project?: string) {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    return this.request<{ tasks: Card[] }>("GET", `/tasks${q}`).then(r => r.tasks ?? []);
  }
  peers()   { return this.request<{ peers: Peer[] }>("GET", "/peers").then(r => r.peers ?? []); }
  health() { return this.request<HubHealth>("GET", "/health"); }
  events(opts: { project?: string; type?: string; since?: number; limit?: number } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    return this.request<{ events: HubEvent[]; cursor?: number; latest?: number }>("GET", `/events${s ? "?" + s : ""}`);
  }
  moveCard(id: number, status: string) { return this.request("POST", "/task/update", { id, status }); }

  /** #5624: tick one acceptance item; returns the updated card. Index-addressed — the hub 400s a
   *  stale index instead of silently toggling the wrong item. */
  checklistToggle(id: number, index: number, done: boolean) {
    return this.request<{ ok: boolean; task: Card }, { id: number; index: number; done: boolean }>(
      "POST", "/task/checklist-toggle", { id, index, done }).then(r => r.task);
  }

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
  /** The overseer's own heartbeat + live watch state — quiet must be distinguishable from dead. */
  overseerStatus() {
    return this.request<OverseerStatus>("GET", "/overseer/status");
  }
  setAutonomy(project: string, level: number) {
    return this.request("POST", "/policy", { autonomy: { [project]: level } });
  }
  /** Agent-proposed permissions awaiting (or past) the human's decision. */
  proposals(opts: { project?: string; status?: string } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    return this.request<{ proposals: Proposal[]; pendingCount: number }>("GET", `/proposals${s ? "?" + s : ""}`);
  }
  /** THE human act in the governance loop — owner-signed via hub_request; nothing auto-approves. */
  decideProposal(id: number, status: "approved" | "denied", note?: string): Promise<{ ok: boolean; proposal: Proposal }> {
    return this.request("POST", "/proposal/decide", { id, status, note });
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
  /**
   * Tell the hub this endpoint has actually read up to `upTo`. The app lists with peek=1 so it
   * never steals a message from a session's delivery hooks, but a HUMAN endpoint has no hooks —
   * this app is the only reader — so without an explicit ack sasha@mac's watermark stayed at 0 and
   * every message already read kept escalating as undelivered. Monotonic hub-side.
   */
  async delivered(upTo: number): Promise<void> {
    if (!Number.isSafeInteger(upTo) || upTo <= 0) return;
    await this.request("POST", "/delivered", { session: await this.me(), upTo }).catch(() => {});
  }

  /** The name we SIGN as, fetched once from Rust. */
  private meCache = "";
  private async me(): Promise<string> {
    if (!this.meCache) this.meCache = await invoke<string>("identity_name");
    return this.meCache;
  }

  /**
   * The hub requires `from` and rejects it unless it matches the request signer:
   *   if (!b.from || !text.trim()) return 400 "from and non-empty text required"
   * This omitted it entirely, so every send from the app — the composer as well as the new inbox
   * quick actions — came back 400. Nothing surfaced it until a reply button put the failure where
   * someone would look.
   */
  async send(to: string, text: string, project?: string): Promise<{ ok: boolean; id: number }> {
    return this.request("POST", "/send", { from: await this.me(), to, text, project });
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
        // onEvent expects a HubEvent; JSON.parse's `any` flows into that parameter with no cast.
        try { onEvent(JSON.parse(ev.payload)); } catch { /* a bad frame must not kill the feed */ }
      });
      await invoke("start_stream", { base: this.baseUrl });
      onOpen?.();   // connected — distinct from "an event arrived", which may be much later on an idle project
    })();
    return () => { stopped = true; unlisten?.(); };
  }
}

export function dutyStart(): Promise<string> {
  return invoke<string>("duty_start");
}

export function dutyStop(): Promise<string> {
  return invoke<string>("duty_stop");
}

export function dutyLogPath(): Promise<string> {
  return invoke<string>("duty_log_path");
}

export function policySet(project: string, level: number): Promise<string> {
  return invoke<string>("policy_set_level", { project, level });
}

export function policyLink(projects: string[], reason: string): Promise<string> {
  return invoke<string>("policy_link_projects", { projects, reason });
}

export function policyUnlink(projects: string[]): Promise<string> {
  return invoke<string>("policy_unlink_projects", { projects });
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

/** The hub was unreachable or the reply never arrived intact — a transport failure, not a refusal.
 * `detail` keeps the original transport string: the point is to TRANSLATE the failure, never to hide
 * it, so the raw text stays one property away for a bug report. */
export class HubTransportError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) { super(message); this.detail = detail; }
}

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

/** A project's own icon, read off the repo on THIS machine — same reason as cardCode: repos live
 * here, hubs don't have them. Returns a `data:` URI, or null when the repo ships no art (roughly
 * 60% of them), which is the caller's cue to fall back to a monogram. Never throws: a project the
 * app can see but whose directory is missing must still render a row. */
export async function projectIcon(project: string): Promise<string | null> {
  try {
    const v = await invoke<string | null>("project_icon", { project });
    return v || null;
  } catch { return null; }
}

export type AttachmentInfo = { bytes: number; thumb: string | null };

/** An attached file's facts off the disk (#6070): its size, plus a `data:` URI thumbnail when it is
 * an image the webview can paint and small enough to inline. null when the path is not a file —
 * the chip then degrades to name-only rather than erroring. Never throws. */
export async function attachmentInfo(path: string): Promise<AttachmentInfo | null> {
  try {
    return await invoke<AttachmentInfo | null>("attachment_info", { path });
  } catch { return null; }
}

/** A project with a live session, plus herdr's lifecycle status when its orch pane answered one
 * ("working" | "idle" | "blocked" | "done" | "unknown"). `status` is null when this project's
 * presence is process-truth only (interactive claude window or crew seat pgrep/lsof found, but
 * no herdr pane confirmed a status for it). */
export type LocalSession = { project: string; status: string | null };

/** Projects with a live session — interactive claude windows + crew seats found by PROCESS
 * truth on this machine, PLUS any project whose orch pane herdr can still name an agent for,
 * wherever that pane's process actually runs (#6163: a freshly-woken pane herdr already sees
 * has no local process to pgrep and no heartbeat yet — hooks fire on tool calls, and a pane that
 * hasn't run one has none — so process truth alone dropped it the moment its one heartbeat aged
 * out of the 90s work window). This, not heartbeat freshness, is what "a terminal window is
 * open" means; heartbeats ride hook fires, so an idle-but-open session goes dark on the hub
 * after 5 quiet minutes. */
export async function localSessions(): Promise<LocalSession[]> {
  try { return await invoke<LocalSession[]>("local_sessions"); } catch { return []; }
}

export type AppUpdate = {
  current: string; latest: string; tag: string;
  assetName: string; url: string; size: number; updateAvailable: boolean;
};

/** Is a newer app release out? Runs in Rust (GitHub API — the webview's CSP can't go there).
 * Returns null on any failure: an update check that can't reach GitHub is a non-event, not an
 * error the operator should see. */
export async function appUpdateCheck(): Promise<AppUpdate | null> {
  try { return await invoke<AppUpdate>("app_update_check"); } catch { return null; }
}

/** Download + install the release DMG and relaunch. On SUCCESS this promise never resolves —
 * the process exits mid-flight and the new app takes over. It only ever rejects. */
export async function appUpdateInstall(u: AppUpdate): Promise<void> {
  return invoke("app_update_install", { url: u.url, assetName: u.assetName });
}

/** Open a file/url the way the operator prefers (Settings → "Open code in"). */
export async function openCode(target: string, kind: "url" | "path" | "reveal" = "path"): Promise<void> {
  return invoke("open_code", { target, kind });
}

const EDITOR_PREFS = ["default", "vscode", "cursor", "zed", "reveal"] as const;
export type EditorPref = (typeof EDITOR_PREFS)[number];
const EDITOR_PREF_SET: ReadonlySet<string> = new Set(EDITOR_PREFS);
/** localStorage holds whatever a prior app version wrote; only trust it once it's been checked
 * against the live set of prefs. */
export function isEditorPref(s: string): s is EditorPref { return EDITOR_PREF_SET.has(s); }
export function editorPref(): EditorPref {
  try {
    const v = localStorage.getItem("tr.editor");
    return v !== null && isEditorPref(v) ? v : "default";
  } catch { return "default"; }
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
