// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairPhone } from "./PairPhone";
import { pairInviteApi, phoneHubAddress, PairRoleUnsupportedError, type PairInvite, type PairPhoneApi } from "./pairInvite";
import { HubClient } from "../../shared/api/client";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HUB = "http://127.0.0.1:4477";
const FAKE_QR = "data:image/png;base64,FAKEQR";
const inviteFor = (overrides: Partial<PairInvite> = {}): PairInvite => ({
  link: `trantor://enroll?hub=${encodeURIComponent(HUB)}&token=${"ab".repeat(32)}`,
  token: "ab".repeat(32),
  hub: HUB,
  hubPublic: false,
  expiresAt: Date.now() + 600000,
  ...overrides,
});

// The QR renderer is a prop (default: the qrcode package), so tests inject a stub — no module mocking.
const stubQr = vi.fn(async () => FAKE_QR);

const $ = (sel: string): Element | null => document.querySelector(sel);

describe("Settings Pair a phone", () => {
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
    vi.restoreAllMocks();
  });

  const mount = async (props: Parameters<typeof PairPhone>[0]) => {
    await act(async () => { root.render(<PairPhone {...props} />); });
  };

  const click = async (button: Element) => {
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  };

  it.each(["http://127.0.0.1:4477", "http://localhost:4477", "http://[::1]:4477"])("explains %s before minting and never renders a QR", async hubBase => {
    vi.spyOn(HubClient.prototype, "health").mockResolvedValue({ ok: true, authMode: "enforce", peers: 0, messages: 0, streams: 0, publicUrl: "" });
    const mint = vi.spyOn(HubClient.prototype, "pairInvite");
    const qr = vi.fn(async () => FAKE_QR);
    await mount({ hubBase, renderQr: qr });
    await click($("button")!);
    expect(document.body.textContent).toContain("Your phone cannot reach");
    expect(document.body.textContent).toContain("Tailscale on the Mac and iPhone");
    expect(document.body.textContent).toContain("public hub URL");
    expect(mint).not.toHaveBeenCalled();
    expect(qr).not.toHaveBeenCalled();
    expect($("img")).toBeNull();
  });

  it("checks the public netcup address before minting on the configured hub", async () => {
    const publicUrl = "https://netcup-qdrant.tail0f2afd.ts.net";
    const health = vi.spyOn(HubClient.prototype, "health").mockResolvedValue({ ok: true, authMode: "enforce", peers: 0, messages: 0, streams: 0, publicUrl });
    const mint = vi.spyOn(HubClient.prototype, "pairInvite").mockResolvedValue({ ok: true, token: "ab".repeat(32), expiresAt: Date.now() + 600000, scopes: [{ project: "*", role: "approver" }] });
    const invite = await pairInviteApi(HUB).mint("approver");
    expect(invite.hub).toBe(publicUrl);
    expect(invite.hubPublic).toBe(true);
    expect(health.mock.invocationCallOrder[0]).toBeLessThan(mint.mock.invocationCallOrder[0]);
  });

  it("accepts a Tailscale address and rejects wildcard and non-http addresses", () => {
    expect(() => phoneHubAddress("http://100.79.242.104:4477")).not.toThrow();
    for (const hub of ["http://0.0.0.0:4477", "http://[::]:4477", "file://localhost"]) {
      expect(() => phoneHubAddress(hub)).toThrow("cannot reach");
    }
  });

  it("mints the invite on click and shows the QR, the link and the countdown", async () => {
    const invite = inviteFor();
    const api: PairPhoneApi = { mint: vi.fn(async () => invite) };
    await mount({ hubBase: HUB, api, renderQr: stubQr });

    const button = $("button")!;
    expect(button.textContent).toContain("Pair a phone");
    await click(button);

    expect(api.mint).toHaveBeenCalledWith("approver");
    expect(stubQr).toHaveBeenCalledWith(invite.link);
    const img = $("img")!;
    expect(img.getAttribute("alt")).toBe("Pairing QR code");
    expect(img.getAttribute("src")).toBe(FAKE_QR);
    // SAFETY: the ready view renders exactly one input, readOnly, carrying the minted link.
    const input = $("input") as HTMLInputElement;
    expect(input.value).toBe(invite.link);
    expect(document.body.textContent).toMatch(/Expires in \d+:\d\d/);
  });

  it("renders the QR big enough to scan and opens a full-screen overlay Esc or a backdrop click closes", async () => {
    const invite = inviteFor();
    const api: PairPhoneApi = { mint: vi.fn(async () => invite) };
    await mount({ hubBase: HUB, api, renderQr: stubQr });
    await click($("button")!);

    // SAFETY: the inline QR must be at least 260 px on a white card so a phone can read it off the screen.
    const img = $("img")!;
    expect(Number(img.getAttribute("width"))).toBeGreaterThanOrEqual(260);
    expect(img.parentElement?.className).toContain("bg-white");

    const show = [...document.querySelectorAll("button")].find(b => b.textContent === "Show full screen")!;
    await click(show);

    const dialog = $("[role=dialog]")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector("img")).not.toBeNull();
    expect(dialog.textContent).toMatch(/Expires in \d+:\d\d/);

    // SAFETY: Esc closes the overlay.
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect($("[role=dialog]")).toBeNull();

    // SAFETY: re-open, a backdrop click closes it too.
    await click(show);
    await click($("[role=dialog]")!);
    expect($("[role=dialog]")).toBeNull();
    // The inline QR card is still there underneath.
    expect($("img")!.getAttribute("alt")).toBe("Pairing QR code");
  });

  it("explains a hub without the approver role and retries as owner", async () => {
    const invite = inviteFor();
    const api: PairPhoneApi = {
      mint: vi.fn()
        .mockRejectedValueOnce(new PairRoleUnsupportedError("approver", "read"))
        .mockResolvedValueOnce(invite),
    };
    await mount({ hubBase: HUB, api, renderQr: stubQr });

    await click(document.querySelector("button")!);
    expect(document.body.textContent).toContain('does not know the "approver" role yet');
    expect(document.body.textContent).toContain("would pair the phone near-read-only");

    const retry = [...document.querySelectorAll("button")].find(b => b.textContent === "Pair as owner instead")!;
    await click(retry);

    expect(api.mint).toHaveBeenNthCalledWith(2, "owner");
    // SAFETY: the ready view renders exactly one input, readOnly, carrying the minted link.
    expect(($("input") as HTMLInputElement).value).toBe(invite.link);
  });

  it("shows a transport failure instead of a QR", async () => {
    const api: PairPhoneApi = { mint: vi.fn(async () => { throw new Error("not enrolled on " + HUB); }) };
    await mount({ hubBase: HUB, api, renderQr: stubQr });
    await click(document.querySelector("button")!);
    expect(document.body.textContent).toContain(`not enrolled on ${HUB}`);
    expect($("img")).toBeNull();
  });

  it("degrades to a hint when no hub is configured", async () => {
    const api: PairPhoneApi = { mint: vi.fn() };
    await mount({ hubBase: "", api, renderQr: stubQr });
    expect(document.body.textContent).toContain("No hub configured yet");
    expect($("button")).toBeNull();
    expect(api.mint).not.toHaveBeenCalled();
  });

  it("says the public link works without Tailscale (#12153)", async () => {
    const invite = inviteFor({
      hub: "https://netcup-qdrant.tail0f2afd.ts.net",
      link: `trantor://enroll?hub=${encodeURIComponent("https://netcup-qdrant.tail0f2afd.ts.net")}&token=${"ab".repeat(32)}`,
      hubPublic: true,
    });
    const api: PairPhoneApi = { mint: vi.fn(async () => invite) };
    await mount({ hubBase: HUB, api, renderQr: stubQr });
    await click($("button")!);
    expect(document.body.textContent).toContain("Works without Tailscale");
    expect(document.body.textContent).not.toContain("Needs Tailscale on the phone");
  });

  it("says a tailnet link needs Tailscale on the phone (#12153)", async () => {
    const invite = inviteFor({ hubPublic: false });
    const api: PairPhoneApi = { mint: vi.fn(async () => invite) };
    await mount({ hubBase: HUB, api, renderQr: stubQr });
    await click($("button")!);
    expect(document.body.textContent).toContain("Needs Tailscale on the phone");
    expect(document.body.textContent).not.toContain("Works without Tailscale");
  });
});
