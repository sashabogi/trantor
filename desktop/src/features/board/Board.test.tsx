// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient, type Card } from "../../shared/api/client";
import { Board } from "./Board";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Board stale count", () => {
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
  });

  it("keeps the stale total in a header chip beside the done ratio", async () => {
    const cards: Card[] = [
      { id: 1, project: "drills", title: "done", status: "done" },
      { id: 2, project: "drills", title: "stale one", status: "stale" },
      { id: 3, project: "drills", title: "stale two", status: "stale" },
      { id: 4, project: "drills", title: "queued", status: "todo" },
    ];
    const client = new HubClient("http://unused");
    vi.spyOn(client, "tasks").mockResolvedValue(cards);
    vi.spyOn(client, "peers").mockResolvedValue([]);
    vi.spyOn(client, "streamEvents").mockReturnValue(() => {});

    await act(async () => {
      root.render(<Board client={client} project="drills" lens="board" onLens={() => {}} />);
      await Promise.resolve();
    });

    const chip = host.querySelector('[aria-label="2 stale cards"]');
    expect(chip?.classList.contains("tr-chip")).toBe(true);
    expect(chip?.textContent).toContain("2 stale");
    expect(chip?.previousElementSibling?.textContent).toContain("1/4 done");
  });
});
