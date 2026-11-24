// @vitest-environment happy-dom
// #13993: live Open VSX mapping, debounce, error state and the disabled install reason.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient } from "../../../shared/api/client";
import { ExtensionsScreen } from ".";
import { mapSearch, type RawExt, type RawSearch } from "./openvsx";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BODY = {
  totalSize: 124,
  extensions: [
    { namespace: "rust-lang", name: "rust-analyzer", displayName: "rust-analyzer", description: "Rust language support", version: "0.4.3131", downloadCount: 7800000, averageRating: 4.5, files: { icon: "https://open-vsx.org/i.png" }, verified: true },
    { namespace: "acme", name: "plain", description: "No frills", version: "1.0.0", downloadCount: 12, averageRating: 0 },
  ],
};

const HUB = {
  "/peers": { peers: [{ session: "codex-8", machine: "netcup" }] },
  "/balances": { ts: 0, entries: [{ provider: "glm", label: "GLM", kind: "quota", ok: true, low: false }], lowCount: 0, stale: false },
};
const client = new HubClient("http://hub.test", async ({ path }) => ({ status: 200, body: JSON.stringify(path.startsWith("/peers") ? HUB["/peers"] : HUB["/balances"]) }));

let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const render = (node: ReactNode) => act(() => { root.render(node); });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(400); });
const ok = (body: RawSearch | RawExt) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
const mount = () => render(<ExtensionsScreen client={client} project="" onNavigate={() => {}} />);

describe("mapSearch", () => {
  it("maps real fields and treats a zero rating as no rating", () => {
    const { total, items } = mapSearch(BODY);
    expect(total).toBe(124);
    expect(items[0]).toMatchObject({ id: "rust-lang.rust-analyzer", downloads: 7800000, rating: 4.5, verified: true });
    expect(items[1]).toMatchObject({ displayName: "plain", rating: null, iconUrl: null, verified: false });
  });
  it("rejects an unexpected body", () => { expect(() => mapSearch({})).toThrow(); });
});

describe("ExtensionsScreen", () => {
  it("debounces typing into one search and renders mapped rows", async () => {
    fetchMock.mockResolvedValue(ok(BODY));
    mount();
    await flush();
    fetchMock.mockClear();
    const input = host.querySelector<HTMLInputElement>("#ext-search");
    for (const v of ["r", "ru", "rust"]) {
      act(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        set?.call(input, v);
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("https://open-vsx.org/api/-/search?");
    expect(url).toContain("query=rust");
    expect(url).toContain("sortBy=relevance");
    expect(host.textContent).toContain("rust-analyzer");
    expect(host.textContent).toContain("7.8 M installs");
    expect(host.textContent).toContain("124 results");
  });

  it("shows an honest error when Open VSX fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    mount();
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("network down");
  });

  it("keeps every install control disabled with the spike reason", async () => {
    fetchMock.mockResolvedValue(ok(BODY));
    mount();
    await flush();
    const rowInstall = [...host.querySelectorAll("button")].find(b => b.textContent === "Install");
    expect(rowInstall?.disabled).toBe(true);
    expect(rowInstall?.title).toBe("Installs open after the extension-host spike (#13985)");
    fetchMock.mockResolvedValue(ok({ reviewCount: 23, license: "MIT", timestamp: "2026-11-20T00:00:00Z" }));
    const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open rust-analyzer"]');
    act(() => open?.click());
    await flush();
    const detailInstall = [...host.querySelectorAll("button")].find(b => b.textContent === "Install for this project");
    expect(detailInstall?.disabled).toBe(true);
    expect(detailInstall?.title).toContain("#13985");
    expect(host.textContent).toContain("23 reviews");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
  });
});
