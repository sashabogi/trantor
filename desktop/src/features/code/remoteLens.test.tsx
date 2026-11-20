// @vitest-environment happy-dom
// #13938 — the drill's three states: a dirty remote seat lists its changed files with counts,
// a clean one says clean, ssh down says unreachable — never clean. GitPanel's remote variant is
// read-only; RemoteDoc diffs a deleted file without loading the monaco viewer (lazy import).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ModePane } from "./ModePane";
import { GitPanel } from "./GitPanel";
import { RemoteDoc } from "./RemoteDoc";
import { HubClient, type Peer } from "../../shared/api/client";
import type { RemoteSeatSnapshot } from "./remoteSeatApi";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snap = (over: Partial<RemoteSeatSnapshot>): RemoteSeatSnapshot => ({
  machine: "netcup",
  branch: "seat/kimi-9",
  upstream: null,
  ahead: 2,
  behind: null,
  base: "deadbee",
  status: [],
  counts: [],
  committed: [],
  log: [{ sha: "abc1234", author: "Ada", when: "2 hours ago", subject: "fix: the thing" }],
  ...over,
});

const peers: Peer[] = [
  { session: "kimi-9:trantor", machine: "netcup", online: true },
  { session: "glm-5:trantor", machine: "MacBook-Pro-M1", online: true },
  { session: "MacBook-Pro-M1:trantor", machine: "MacBook-Pro-M1", online: true },
];

const stubClient: HubClient = Object.assign(Object.create(HubClient.prototype), {
  peers: async () => peers,
  tasks: async () => [],
});

const dirtySnap = snap({
  status: [{ path: "desktop/src/dirty.ts", x: "M", y: "M" }, { path: "new.ts", x: "?", y: "?" }],
  counts: [{ path: "desktop/src/dirty.ts", plus: 12, minus: 3 }],
  committed: [{ path: "desktop/src/dirty.ts", plus: 12, minus: 3 }, { path: "landed.rs", plus: 40, minus: 2 }],
});

const baseMocks = (snapshot: () => Promise<string>) => {
  // machine_ssh is only ever asked for "netcup" here — kimi-9 is the one remote seat in peers
  mockIPC(command => {
    switch (command) {
      case "machine_id": return "MacBook-Pro-M1";
      case "machine_ssh": return "netcup";
      case "remote_seat_snapshot": return snapshot();
      case "project_changes": return "[]";
      default: return undefined;
    }
  });
};

describe("ModePane remote seats (#13938)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    clearMocks();
  });

  const render = (seat: string | null) => act(() => root.render(
    <ModePane client={stubClient} project="trantor" seat={seat} onSeat={() => {}} onOpenFile={() => {}} />
  ));
  const settled = async (seat: string | null) => { render(seat); await act(async () => {}); };

  it("a dirty remote seat lists its changed files with counts, from that machine", async () => {
    baseMocks(async () => JSON.stringify(dirtySnap));
    await settled("kimi-9");
    expect(host.textContent).toContain("CHANGED · seat/kimi-9 on netcup · read-only");
    expect(host.textContent).toContain("dirty.ts");
    expect(host.textContent).toContain("+12");
    expect(host.textContent).toContain("new");
    expect(host.textContent).toContain("landed.rs");
    // the scope face carries the honest count, not a local zero
    expect(host.textContent).toContain("3 changed");
  });

  it("a clean remote seat says clean — measured over ssh, not by a missing local worktree", async () => {
    baseMocks(async () => JSON.stringify(snap({ ahead: 0, log: [] })));
    await settled("kimi-9");
    expect(host.textContent).toContain("Clean — no changes on netcup.");
  });

  it("ssh down says unreachable, never clean", async () => {
    baseMocks(async () => { throw "unreachable: ssh: connect to host netcup port 22: Operation timed out"; });
    await settled("kimi-9");
    expect(host.textContent).toContain("unreachable — seat/kimi-9 on netcup could not be read.");
    expect(host.textContent).not.toContain("Clean");
    // the scope face says it too, in the danger colour's text
    expect(host.querySelector(".text-tr-danger")?.textContent).toContain("unreachable");
  });

  it("a remote seat with no ssh target says where it lives and how to read it", async () => {
    baseMocks(async () => JSON.stringify(dirtySnap));
    mockIPC((command) => {
      if (command === "machine_id") return "MacBook-Pro-M1";
      if (command === "machine_ssh") return null;
      if (command === "project_changes") return "[]";
      return undefined;
    });
    await settled("kimi-9");
    expect(host.textContent).toContain("on netcup");
    expect(host.textContent).toContain("machines.netcup.ssh");
    expect(host.textContent).not.toContain("Clean — no changes anywhere.");
  });

  it("opening a remote changed file hands the path to the lens, read-only titled", async () => {
    baseMocks(async () => JSON.stringify(dirtySnap));
    const opened: string[] = [];
    await act(() => root.render(
      <ModePane client={stubClient} project="trantor" seat="kimi-9" onSeat={() => {}} onOpenFile={p => opened.push(p)} />
    ));
    await act(async () => {});
    const row = host.querySelector<HTMLButtonElement>("button[title^='desktop/src/dirty.ts']");
    expect(row).toBeTruthy();
    act(() => row!.click());
    expect(opened).toEqual(["desktop/src/dirty.ts"]);
    expect(row!.getAttribute("title")).toContain("read-only");
  });
});

describe("GitPanel remote variant (#13938)", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    clearMocks();
  });

  it("renders the seat's git state with no mutation affordances at all", () => {
    act(() => root.render(
      <GitPanel
        project="trantor"
        seat="kimi-9"
        remote={{ seat: "kimi-9", machine: "netcup", state: { kind: "ok", snap: dirtySnap } }}
      />
    ));
    const text = host.textContent ?? "";
    expect(text).toContain("seat/kimi-9");
    expect(text).toContain("read-only");
    expect(text).toContain("seat/kimi-9"); // branch line
    expect(text).toContain("Staged");
    expect(text).toContain("dirty.ts");
    expect(text).toContain("fix: the thing");
    expect(text).not.toContain("Commit");
    expect(text).not.toContain("Push");
    expect(host.querySelector("input")).toBeNull();
  });

  it("unreachable renders as unreachable, never as a clean panel", () => {
    act(() => root.render(
      <GitPanel
        project="trantor"
        seat="kimi-9"
        remote={{ seat: "kimi-9", machine: "netcup", state: { kind: "unreachable", reason: "ssh: connect timed out" } }}
      />
    ));
    expect(host.textContent).toContain("unreachable — seat/kimi-9 on netcup could not be read.");
    expect(host.textContent).not.toContain("Nothing staged.");
  });
});

describe("RemoteDoc (#13938)", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    clearMocks();
  });

  it("shows the diff vs base even when the body is gone, and says read-only", async () => {
    mockIPC(command => {
      if (command === "remote_file_body") throw "no such file on the remote machine: gone.ts";
      if (command === "remote_file_patch") return JSON.stringify({ patch: "--- a/gone.ts\n+++ b/gone.ts\n@@ -1 +0,0 @@\n-one\n", truncated: false });
      return undefined;
    });
    act(() => root.render(<RemoteDoc project="trantor" seat="kimi-9" machine="netcup" path="gone.ts" />));
    await act(async () => {});
    const text = host.textContent ?? "";
    expect(text).toContain("read-only");
    // the body is gone, so the diff opened itself — the patch is on screen without a click
    expect(text).toContain("--- a/gone.ts");
    expect(text).toContain("diff vs base");
  });

  it("an unreachable machine shows unreachable with the reason, not an empty viewer", async () => {
    mockIPC(() => { throw "unreachable: ssh: connect timed out"; });
    act(() => root.render(<RemoteDoc project="trantor" seat="kimi-9" machine="netcup" path="a.ts" />));
    await act(async () => {});
    expect(host.textContent).toContain("unreachable");
    expect(host.textContent).toContain("ssh: connect timed out");
  });
});
