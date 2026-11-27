// @vitest-environment happy-dom
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScmSidebar } from "./index";
import { MainHealth } from "../../shell/HeaderBand/MainHealth";

const message = vi.fn();
const worktree = { path: "/repo/agent-abcdef123", kind: "agent" as const, branch: "wt-agent", head: "abc", locked: false, last_activity: 0, changed: 2, ahead: 1 };
const snapshot = { branch: "main", upstream: null, remote: null, ahead: 0, behind: 0, status: [{ path: "a.ts", x: " ", y: "M" }, { path: "b.ts", x: "?", y: "?" }], counts: [], log: [], seatBacked: false, readAt: 0, scope: null };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => mem.get(key) ?? null, setItem: (key: string, value: string) => mem.set(key, value), removeItem: (key: string) => mem.delete(key) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  message.mockClear();
  mockIPC(command => {
    if (command === "git_worktrees") return JSON.stringify([worktree]);
    if (command === "git_panel") return JSON.stringify(snapshot);
    if (command === "git_stash_list") return "[]";
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); });
function Fixture({ canAsk = true, initial = null }: { canAsk?: boolean; initial?: string | null }) {
  const [scope, setScope] = useState<string | null>(initial);
  return <><MainHealth project="trantor" snap={snapshot} status={null} onNavigate={() => {}} />
    <ScmSidebar project="trantor" scope={scope} scopeName={scope ?? "checkout"} hostPicksWorktree state={{ kind: "ok", snap: { ...snapshot, scope, seatBacked: !!scope } }} seats={[]}
      onPickScope={setScope} onMutated={() => {}} onOpenFile={() => {}} onOpenChange={() => {}} onOpenCommit={() => {}} onReviewMessage={message} canAskOrchestrator={canAsk} /></>;
}
const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.startsWith(text));
const click = async (text: string) => { expect(button(text)).toBeDefined(); await act(async () => button(text)?.click()); };

it("Review names the worktree, count and lock, and both Back controls return to checkout", async () => {
  await act(async () => root.render(<Fixture />));
  expect(host.querySelector("[data-review-band]")).toBeNull();
  await click("Review");
  const band = host.querySelector("[data-review-band]");
  expect(band?.textContent).toContain("Reviewing agent abcdef1's work");
  expect(band?.textContent).toContain("its own worktree · 2 files · read only");
  expect(band?.getAttribute("title")).toBe("agent-abcdef123");
  expect(host.querySelector('[aria-label="Review scope"]')?.textContent).toContain("Reviewing agent abcdef1");
  await click("Back to my checkout (main)");
  expect(host.querySelector("[data-review-band]")).toBeNull();
  expect(host.querySelector('[aria-label="Review scope"]')).toBeNull();
  await click("Review");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Review scope"] button')?.click());
  expect(host.querySelector("[data-review-band]")).toBeNull();
});

it("Escape only returns while focus is inside the column", async () => {
  await act(async () => root.render(<Fixture />)); await click("Review");
  await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector("[data-review-band]")).not.toBeNull();
  button("Back to my checkout")?.focus();
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector("[data-review-band]")).toBeNull();
});

it("explains the unavailable merge and routes agent questions with the reviewed identity", async () => {
  await act(async () => root.render(<Fixture />)); await click("Review");
  expect(button("Merge into main")?.disabled).toBe(true);
  expect(button("Merge into main")?.title).toContain("not available");
  await click("Ask the orchestrator");
  expect(message).toHaveBeenCalledWith({ scope: "wt:/repo/agent-abcdef123", name: "agent abcdef1", files: 2 });
});

it("explains why an agent cannot be messaged without an orchestrator", async () => {
  await act(async () => root.render(<Fixture canAsk={false} />)); await click("Review");
  expect(button("Ask the orchestrator")?.disabled).toBe(true);
  expect(button("Ask the orchestrator")?.title).toBe("Sub-agents don't take messages; start the orchestrator to ask about this work.");
});

it("routes seat messages to that seat", async () => {
  await act(async () => root.render(<Fixture initial="codex-8" />));
  await click("Message codex-8");
  expect(message).toHaveBeenCalledWith({ scope: "codex-8", name: "codex-8", files: 2 });
});
