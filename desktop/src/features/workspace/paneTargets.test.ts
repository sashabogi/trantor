import { describe, expect, it } from "vitest";
import { isAgentPeer, paneTargets } from "./paneTargets";
import type { Peer } from "../../shared/api/client";
import type { HerdrSeat } from "./herdr";

const orch: HerdrSeat = { project: "trantor", agent: "orchestrator", surface: "surf-1", kind: "orch" };
const host: Peer = { session: "MacBook-Pro-M1:trantor", online: true, status: "working", lastSeen: 5 };
const codex: Peer = { session: "codex:trantor", online: true, status: "idle" };

describe("paneTargets", () => {
  it("the orchestrator row keeps the herdr pane name as its terminal key and brands from the host (0.3.99 regression)", () => {
    // 0.3.99 wrote the host session into `agent` to get the Claude mark, and the terminal pane
    // then looked up a herdr surface named "MacBook-Pro-M1:trantor" — none exists, so the
    // operator's own session rendered as "has no terminal pane". Two fields, two jobs.
    const [lead] = paneTargets([codex], orch, host, "trantor");
    expect(lead.isOrchestrator).toBe(true);
    expect(lead.agent).toBe("orchestrator");
    expect(lead.brand).toBe("MacBook-Pro-M1:trantor");
    expect(lead.session).toBe("MacBook-Pro-M1:trantor");
    expect(lead.status).toBe("working");
  });

  it("without a host peer the orchestrator brands from its own pane name", () => {
    const [lead] = paneTargets([], orch, undefined, "trantor");
    expect(lead.agent).toBe("orchestrator");
    expect(lead.brand).toBe("orchestrator");
    expect(lead.session).toBe("trantor orchestrator");
    expect(lead.online).toBe(true);
  });

  it("crew seats key, brand and lookup by their agent name", () => {
    const rows = paneTargets([codex], null, host, "trantor");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "codex:trantor", agent: "codex", brand: "codex", isOrchestrator: false });
  });

  it("#6068: the genesis tool is not a seat; a kindless peer (old hub) still is", () => {
    const genesis: Peer = { session: "genesis:trantor", online: true, status: "idle", kind: "tool" };
    const agent: Peer = { session: "glm:trantor", online: true, status: "idle", kind: "agent" };
    const oldHub: Peer = { session: "qwen:trantor", online: true, status: "idle" };
    expect(isAgentPeer(genesis)).toBe(false);
    expect(isAgentPeer(agent)).toBe(true);
    expect(isAgentPeer(oldHub)).toBe(true);
    // the strip: the genesis row never reaches paneTargets once seatsOf filters
    const rows = paneTargets([genesis, agent, oldHub].filter(isAgentPeer), null, host, "trantor");
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.agent)).toEqual(["glm", "qwen"]);
  });

  it("#6081: while a handoff chain runs the orchestrator tab reads 'handing off'; seats are untouched", () => {
    const rows = paneTargets([codex], orch, host, "trantor", true);
    const [lead, seat] = rows;
    expect(lead.isOrchestrator).toBe(true);
    expect(lead.label).toBe("handing off");
    // the terminal lookup key and the identity NEVER change mid-chain — only the label does
    expect(lead.agent).toBe("orchestrator");
    expect(lead.brand).toBe("MacBook-Pro-M1:trantor");
    expect(lead.key).toBe("__orchestrator__");
    expect(seat.isOrchestrator).toBe(false);
    expect(seat.label).toBe("codex");
  });

  it("#6081: no chain means the orchestrator tab keeps its own name", () => {
    const [lead] = paneTargets([codex], orch, host, "trantor", false);
    expect(lead.label).toBe("orchestrator");
    const [leadDefault] = paneTargets([codex], orch, host, "trantor");
    expect(leadDefault.label).toBe("orchestrator");
  });
});
