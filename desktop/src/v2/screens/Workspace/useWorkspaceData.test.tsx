// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HubClient } from "../../../shared/api/client";
import { usePeerList } from "./useWorkspaceData";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
function Probe({ client }: { client: HubClient }) {
  const { peers, error, refresh } = usePeerList(client);
  return <><p>{error ?? (peers === null ? "Reading seats" : `${peers.length} seats`)}</p><button onClick={refresh}>Refresh</button></>;
}
it("clears a failed peer read when a later refresh succeeds", async () => {
  let offline = true;
  const client = new HubClient("http://hub.test", async () => {
    if (offline) throw new Error("connection refused");
    return { status: 200, body: JSON.stringify({ peers: [] }) };
  });
  const stream = vi.spyOn(client, "streamEvents").mockReturnValue(() => {});
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe client={client} />));
    expect(host.querySelector("p")?.textContent).toContain("Can't reach the hub");
    offline = false;
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("p")?.textContent).toBe("0 seats");
  } finally { act(() => root.unmount()); stream.mockRestore(); }
});
