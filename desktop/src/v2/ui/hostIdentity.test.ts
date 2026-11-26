import { describe, expect, it } from "vitest";
import { isHostSession, seatLabel } from "./identity";
import { brandFor, displayName } from "../../shared/Avatar";
import { shortName } from "../../features/messages/Messages";
import { scopeSeats } from "../../features/code/scopeSeats";
import { remoteSeatMachines } from "../../features/code/remoteScope";
import { hostPeer, seatPeers } from "../screens/Workspace/seatModel";
import { liveOrchestratorProjects } from "../shell/useShellData";

const peers = [
  { session: "studio-7:demo", project: "demo", machine: "studio-7", online: true },
  { session: "MacBook-Other:demo", project: "demo", machine: "remote", online: true },
  { session: "codex-2:demo", project: "demo", machine: "remote", online: true },
];

describe("machine identity", () => {
  it("uses the complete machine component, with the old prefix only while loading", () => {
    expect(isHostSession("studio-7:demo", "studio-7")).toBe(true);
    expect(isHostSession("studio-70:demo", "studio-7")).toBe(false);
    expect(isHostSession("MacBook-Other:demo", "studio-7")).toBe(false);
    expect(isHostSession("MacBook-Other:demo")).toBe(true);
  });
  it("uses the same identity for host, worktree and remote seat selection", () => {
    expect(hostPeer(peers, "demo", "studio-7")).toBe(peers[0]);
    expect(seatPeers(peers, "demo", "studio-7")).toEqual(peers.slice(1));
    expect(scopeSeats(peers, "demo", "studio-7")).toEqual(["MacBook-Other", "codex-2"]);
    expect([...remoteSeatMachines(peers, "demo", "studio-7").keys()]).toEqual(["MacBook-Other", "codex-2"]);
    expect(liveOrchestratorProjects([], [peers[0]], "studio-7")).toEqual(["demo"]);
    expect(liveOrchestratorProjects([], [peers[1]], "studio-7")).toEqual([]);
  });
  it("labels and brands the known host and preserves unrelated host-looking identities", () => {
    expect(seatLabel("studio-7:demo", "studio-7")).toBe("orchestrator");
    expect(seatLabel("MacBook-Other:demo", "studio-7")).toBe("MacBook-Other");
    expect(brandFor("studio-7:demo", undefined, "studio-7")?.label).toBe("Claude");
    expect(brandFor("MacBook-Other:demo", undefined, "studio-7")).toBeNull();
    expect(displayName("studio-7:demo", undefined, "studio-7")).toBe("claude · studio-7");
    expect(shortName("studio-7:demo", "studio-7")).toBe("demo");
    expect(shortName("MacBook-Other:demo", "studio-7")).toBe("MacBook-Other:demo");
    expect(seatLabel("claude:trantor-duty", "studio-7")).toBe("trantor-duty");
  });
});
