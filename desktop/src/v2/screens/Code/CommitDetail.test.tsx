// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { CommitDetail } from "./CommitDetail";
import { toRow } from "./model";
import type { GitCommitMeta } from "./scopeGitApi";

const open = vi.fn().mockResolvedValue(undefined);

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const parent = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const row = toRow({ sha: "aaaaaaa", author: "Tess", when: "1h", subject: "subject" }, { seats: [], branch: "main" });
let meta: GitCommitMeta;
let host: HTMLDivElement;
let root: Root;
let onSelectCommit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  meta = { sha, author: "Tess", when: "1h", subject: "subject", message: "subject\n\nfull body\non two lines", parents: [parent], github_url: `https://github.com/owner/repo/commit/${sha}` };
  open.mockClear();
  onSelectCommit = vi.fn();
  mockIPC(command => {
    if (command === "git_commit_meta") return JSON.stringify(meta);
    if (command === "git_show") return JSON.stringify({ sha, files: [{ path: "a.ts", status: "M", plus: 3, minus: 1 }], patch: "diff", truncated: false });
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

async function mount() {
  await act(async () => {
    root.render(<CommitDetail row={row} project="trantor" scope={null} cards={[]} onSelectCommit={onSelectCommit}
      acts={{ addToChat: () => undefined, copy: () => undefined, branchRefusal: null }}
      onNavigate={() => undefined} onMutated={() => undefined} onError={() => undefined} openExternal={open} />);
  });
  await flush();
}

it("shows the full message, parent link, file totals and a working GitHub action", async () => {
  await mount();
  expect(host.textContent).toContain("full body\non two lines");
  expect(host.textContent).toContain("1 file changed");
  expect(host.textContent).toContain("+3");
  expect(host.textContent).toContain("−1");
  await act(async () => { host.querySelector<HTMLButtonElement>(`[title="Open parent ${parent}"]`)?.click(); });
  expect(onSelectCommit).toHaveBeenCalledWith(parent);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open on GitHub"]')?.click(); });
  await flush();
  expect(open).toHaveBeenCalledWith(`https://github.com/owner/repo/commit/${sha}`);
  for (const label of ["Crew review this commit", "Review this commit and every later one"]) {
    expect(host.querySelector(`[aria-label="${label}"]`)).toBeNull();
  }
  expect(host.textContent).not.toContain("not wired");
});

it("omits GitHub when origin is not GitHub", async () => {
  meta.github_url = null;
  await mount();
  expect(host.querySelector('[aria-label="Open on GitHub"]')).toBeNull();
});
