// #13938 — who is remote: a seat is remote only when its /peers machine label is set AND
// differs from this machine's machine-id. The orchestrator's MacBook session and unlabeled
// peers are never remote seats, and nothing is remote until we know our own label.
import { describe, expect, it } from "vitest";
import type { Peer } from "../../shared/api/client";
import { remoteSeatMachines } from "./remoteScope";

const peer = (session: string, machine?: string): Peer => ({ session, machine, online: true });

describe("remoteSeatMachines", () => {
  const peers: Peer[] = [
    peer("kimi-9:trantor", "netcup"),
    peer("glm-5:trantor", "MacBook-Pro-M1"),
    peer("codex-7:trantor"),
    peer("MacBook-Pro-M1:trantor", "MacBook-Pro-M1"),
    peer("kimi-9:other-project", "netcup"),
  ];

  it("maps only seats whose machine differs from ours", () => {
    const map = remoteSeatMachines(peers, "trantor", "MacBook-Pro-M1");
    expect([...map.entries()]).toEqual([["kimi-9", "netcup"]]);
  });

  it("no own machine label yet → nothing is remote (never a guess)", () => {
    expect(remoteSeatMachines(peers, "trantor", undefined).size).toBe(0);
  });

  it("an empty machine label is not a machine", () => {
    const map = remoteSeatMachines([peer("x:trantor", "  ")], "trantor", "mac");
    expect(map.size).toBe(0);
  });
});
