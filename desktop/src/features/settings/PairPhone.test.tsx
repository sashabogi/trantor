// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairPhone } from "./PairPhone";
import { PairRoleUnsupportedError, type PairInvite, type PairPhoneApi } from "./pairInvite";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HUB = "http://127.0.0.1:4477";
const FAKE_QR = "data:image/png;base64,FAKEQR";
const inviteFor = (overrides: Partial<PairInvite> = {}): PairInvite => ({
  link: `trantor://enroll?hub=${encodeURIComponent(HUB)}&token=${"ab".repeat(32)}`,
  token: "ab".repeat(32),
  hub: HUB,
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
  });

  const mount = async (props: Parameters<typeof PairPhone>[0]) => {
    await act(async () => { root.render(<PairPhone {...props} />); });
  };

  const click = async (button: Element) => {
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  };

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
});
