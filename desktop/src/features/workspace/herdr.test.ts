import { describe, expect, it } from "vitest";
import { terminalBytes } from "./herdr";

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
