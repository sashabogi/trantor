// The Tauri side of the language-server transport: `lsp-message:<id>` events in, `lsp_send`
// invokes out, framed and owned by Rust (src-tauri/src/lsp.rs). Split out of lspClient.ts so the
// reader/writer are testable against a REAL vscode-jsonrpc connection without booting monaco
// (lspTransport.test.ts).
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageWriter,
} from "vscode-jsonrpc";
import { progressEvent, type ProgressEvent } from "./lspProtocol";

/** The diagnostic firehose (#12752): one line per state change, appended app-side. */
export function trace(line: string): void {
  invoke("app_log", { line }).catch(() => {});
}

/** Render a client/document key for a trace line. Runtime keys join `${workspaceRoot}\u0000${language}`,
 *  and that NUL byte truncates BSD cut/grep reads of app-trace.log right after the path — so trace
 *  lines show the separator as " · " instead. The runtime key is untouched; only the log text changes. */
export function traceKey(key: string): string {
  return key.split("\u0000").join(" · ");
}

/** reader: `lsp-message:<id>` events → JSON-RPC messages.
 *
 *  The Tauri subscription is taken in the CONSTRUCTOR — before client.start() ever sends
 *  `initialize` — and every message is buffered until jsonrpc's listen() attaches its callback.
 *  The lazy subscribe-inside-listen() this replaced raced the handshake: rust-analyzer answers
 *  `initialize` single-digit milliseconds after the request (rust-1.trace: 7ms), while the
 *  Tauri listener registration is an IPC of its own — a response landing in that window was
 *  dropped on the floor, and a lost response hangs client.start() forever: the wire trace showed
 *  the handshake and then silence, no `initialized`, no didOpen, no completion (#5857). */
export class TauriMessageReader extends AbstractMessageReader {
  private callback: DataCallback | null = null;
  private buffered: Message[] = [];
  private unlistens: UnlistenFn[] = [];
  private torn = false;
  /** Resolves once BOTH Tauri subscriptions are registered on the Rust side. The buffer above only
   *  covers the gap between Tauri delivering a message and jsonrpc attaching its callback; the
   *  registration itself is an IPC round trip, and an event Rust emits before it completes is not
   *  delivered at all. The operator's 11:43 attempt (0.3.113): initialize out, the reply in 7ms,
   *  nothing after — the listener did not exist yet. The client awaits this before its first write. */
  readonly ready: Promise<void>;

  constructor(
    private readonly id: number,
    private readonly onProgress?: (e: ProgressEvent) => void,
  ) {
    super();
    const keep = (fn: UnlistenFn) => {
      if (this.torn) fn();
      else this.unlistens.push(fn);
    };
    const messages = listen<string>(`lsp-message:${this.id}`, ev => this.onMessage(ev.payload)).then(keep);
    // The server closing stdout is the one honest "no longer ready" signal; the payload is the
    // server's own first stderr line ("error: Unknown binary …") when it exited early, so the
    // status line can name it instead of a bare "Unknown reason".
    const closed = listen<string | null>(`lsp-closed:${this.id}`, ev => {
      if (this.torn) return;
      if (ev.payload) this.fireError(new Error(ev.payload));
      this.fireClose();
    }).then(keep);
    // A registration that fails still resolves `ready` (after tracing it) so a start never hangs
    // on it — the connection then reports the missing stream on its own.
    this.ready = Promise.all([messages, closed]).then(
      () => { trace(`lsp reader ${this.id}: subscribed`); },
      e => { trace(`lsp reader ${this.id}: subscribe failed: ${e instanceof Error ? e.message : String(e)}`); },
    );
  }

  private onMessage(payload: string): void {
    if (this.torn) return;
    // A non-JSON payload must not throw and swallow the message — the initialize response rides
    // this path, and a dropped response leaves client.start() hanging forever. The connection
    // reports its own error if the bytes are not valid JSON-RPC.
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return;
    }
    if (this.onProgress) {
      const e = progressEvent(raw as Parameters<typeof progressEvent>[0]);
      if (e) this.onProgress(e);
    }
    const msg = raw as Message;
    if (this.callback) {
      this.callback(msg);
    } else {
      this.buffered.push(msg);
    }
  }

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    if (this.buffered.length > 0) {
      trace(`lsp reader ${this.id}: flushing ${this.buffered.length} buffered message(s)`);
      const pending = this.buffered.splice(0);
      for (const msg of pending) callback(msg);
    }
    return {
      dispose: () => {
        this.torn = true;
        this.callback = null;
        for (const fn of this.unlistens) fn();
        this.unlistens.length = 0;
      },
    };
  }
}

/** writer: JSON-RPC messages → `lsp_send`. */
export class TauriMessageWriter extends AbstractMessageWriter implements MessageWriter {
  constructor(private readonly id: number) {
    super();
  }

  async write(msg: Message): Promise<void> {
    // A Tauri rejection is a plain string; vscode-jsonrpc reads `.message` off it and shows
    // "Unknown reason" when there is none (0.3.96, seen on screen). Wrap so the real cause rides.
    try {
      await invoke("lsp_send", { id: this.id, message: JSON.stringify(msg) });
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  end(): void {
    // The connection ends when the lens stops the server; nothing to flush on the wire.
  }
}
