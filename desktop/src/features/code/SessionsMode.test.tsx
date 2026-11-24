// @vitest-environment happy-dom
// #13987 drill: one unreadable harness store leaves a quiet note; the sessions that were read still list.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SessionsMode } from "./SessionsMode";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LISTING = {
  sessions: [{ id: "c1", harness: "claude", title: "Fix the session list", lastMessage: "", messageCount: 4, model: "", branch: "", updatedAt: Date.now(), cwd: "/x" }],
  warnings: [{ store: "opencode", message: "OpenCode session store: file is not a database" }],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mockIPC(command => (command === "sessions_list" ? JSON.stringify(LISTING) : null));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); });

describe("SessionsMode", () => {
  it("lists the readable sessions and notes the unreadable store quietly", async () => {
    await act(async () => { root.render(<SessionsMode project="trantor" onOpenClaude={() => undefined} />); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(host.textContent).toContain("Fix the session list");
    expect(host.textContent).toContain("1 sessions");
    const note = host.querySelector('[data-store-warning="opencode"]');
    expect(note?.textContent).toBe("OpenCode sessions could not be read, so they are not listed.");
    expect(note?.getAttribute("title")).toContain("file is not a database");
    expect(host.querySelector(".text-tr-fail")).toBeNull();
  });
});
