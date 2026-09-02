// The reuse rule (#5857 bounce): a second start never builds a second client for a live server,
// and an already-initialized server with a lost client is respawned, never re-initialized.
import { describe, expect, it } from "vitest";
import { decideLspStart } from "./lspStart";

describe("decideLspStart", () => {
  it("a registered client is reused — never a second client for a live server", () => {
    expect(decideLspStart({ id: 7, initialized: true }, true)).toEqual({ action: "reuse", id: 7 });
    expect(decideLspStart({ id: 7, initialized: false }, true)).toEqual({ action: "reuse", id: 7 });
  });

  it("an initialized server with a lost client is respawned, never re-initialized", () => {
    expect(decideLspStart({ id: 7, initialized: true }, false)).toEqual({ action: "respawn", stopId: 7 });
  });

  it("a fresh (uninitialized) process owes the handshake the new client sends", () => {
    expect(decideLspStart({ id: 7, initialized: false }, false)).toEqual({ action: "fresh" });
  });
});
