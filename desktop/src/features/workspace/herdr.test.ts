import { describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { answerAtPane, terminalBytes } from "./herdr";

// #6094: answerAtPane must write through the Rust `ask_answer` command (herdr's `pane.send_text`,
// the primitive under `agent.prompt` minus its lifecycle gating), a single fire-and-forget call.
// term_attach is a read-only streaming watch client by design; writing to it fails with EIO. This
// test drives the same injectable-invoke seam Chat's ChatDeps uses, not a mocked module.
describe("answerAtPane (#6094, 2026-09-05)", () => {
  it("writes through ask_answer (pane.send_text), never term_attach/term_write/term_detach", async () => {
    const calls: Array<{ cmd: string; args: InvokeArgs | undefined }> = [];
    const invokeFn = async <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
      calls.push({ cmd, args });
      // SAFETY: every command this test drives (ask_answer, app_log) resolves to void — the
      // real Rust side types both that way.
      return undefined as T;
    };

    await answerAtPane("w2:p8", "\x1b[B\r", invokeFn);

    const commands = calls.map(c => c.cmd);
    expect(commands).not.toContain("term_attach");
    expect(commands).not.toContain("term_write");
    expect(commands).not.toContain("term_detach");
    expect(calls).toContainEqual({ cmd: "ask_answer", args: { target: "w2:p8", data: "\x1b[B\r" } });
  });

  it("surfaces the error and traces it when the write fails", async () => {
    const appLogLines: string[] = [];
    const invokeFn = async <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
      if (cmd === "app_log") {
        // SAFETY: answerAtPane's trace() always calls app_log with a plain `{ line: string }`
        // object — never the array/buffer arms of InvokeArgs.
        appLogLines.push((args as { line: string } | undefined)?.line ?? "");
        // SAFETY: app_log's real return type is void.
        return undefined as T;
      }
      if (cmd === "ask_answer") throw new Error("pane_not_found");
      // SAFETY: unknown commands resolve to undefined, matching the real seam's unhandled default.
      return undefined as T;
    };

    await expect(answerAtPane("w2:p8", "\r", invokeFn)).rejects.toThrow("pane_not_found");
    expect(appLogLines.some(l => l.includes("FAILED") && l.includes("pane_not_found"))).toBe(true);
  });
});

describe("terminalBytes", () => {
  it("keeps Uint8Array payloads ready for xterm", () => {
    const bytes = new Uint8Array([27, 91, 65]);
    expect(terminalBytes(bytes)).toBe(bytes);
  });

  it("converts serialized Vec<u8> arrays from Tauri channels", () => {
    expect([...terminalBytes([36, 32, 108, 115])]).toEqual([36, 32, 108, 115]);
  });

  it("converts ArrayBuffer payloads defensively", () => {
    expect([...terminalBytes(new Uint8Array([1, 2, 3]).buffer)]).toEqual([1, 2, 3]);
  });
});
