// @vitest-environment happy-dom
// #13992: the screen mounts on real client calls and shows seats, honest disabled actions, and the Overseer column.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { AgentsScreen } from "./index";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now();
const PEERS = { peers: [
  { session: "codex-8", project: "trantor", lastSeen: now - 5_000, model: "gpt-x", machine: "netcup" },
  { session: "kimi-9", project: "trantor", lastSeen: now - 120_000 },
  { session: "glm-5", project: "other", lastSeen: now - 5_000 },
] };
const OVERSEER = { engine: true, lastTickTs: now - 2_000, tickMs: 30_000, clearMs: 1, dutySession: "claude:trantor-duty",
  watching: { sessions: 3, projects: 2, claims: 0, links: 0 }, autonomy: { trantor: 2 }, links: [], warnings: [], standing: 0 };
const EMPTY = { tasks: [], proposals: [], holds: [], entries: [], machines: [], events: [], ts: now, staleAfterMs: 90_000 };

function bodyFor(path: string) {
  if (path === "/peers") return PEERS;
  if (path === "/overseer/status") return OVERSEER;
  return EMPTY;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mockIPC((command, args) => {
    if (command === "hub_request") {
      // SAFETY: hub_request args are { base, method, path, body } by the HubClient transport contract.
      const path = String((args as { path: string }).path).split("?")[0];
      return { status: 200, body: JSON.stringify(bodyFor(path)) };
    }
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });

describe("AgentsScreen", () => {
  it("lists this project's seats, sorted, with titled icon actions and the Overseer column", async () => {
    const onNavigate = vi.fn();
    await act(async () => { root.render(<AgentsScreen client={new HubClient("http://hub.test")} project="trantor" onNavigate={onNavigate} />); });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    // working codex-8 sorts before ready kimi-9; glm-5 lives in another project so it is not on the roster
    expect([...host.querySelectorAll("article")].map(a => a.getAttribute("aria-label"))).toEqual(["codex-8", "kimi-9"]);
    for (const b of host.querySelectorAll<HTMLButtonElement>("article button[aria-label]")) expect(b.title).not.toBe("");
    expect(host.querySelector('[aria-label="Autonomy ladder"]')).not.toBeNull();
    expect(host.textContent).toContain("trantor-duty");
    act(() => { host.querySelector<HTMLElement>('[aria-label="Open its terminal"]')?.click(); });
    expect(onNavigate).toHaveBeenCalledWith("workspace", "trantor");
  });
});
