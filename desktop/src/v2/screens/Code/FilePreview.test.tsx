// @vitest-environment happy-dom
// #14106: which files open as a preview, the Source switch, and what the image preview says.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { FilePreview, previewKind, sizeLabel } from "./FilePreview";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let imageData: string | null;
beforeEach(() => {
  imageData = "AAEC";
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC(command => {
    if (command === "read_file") return JSON.stringify({ text: "# Title\n\nSome **bold** words", truncated: false, bytes: 28 });
    if (command === "read_image") return JSON.stringify({ mime: "image/png", bytes: 2048, data: imageData });
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearMocks(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const show = async (path: string) => {
  const kind = previewKind(path);
  if (!kind) throw new Error("not a preview kind");
  await act(async () => {
    root.render(<FilePreview kind={kind} project="trantor" scope={null} path={path} source={<div data-source>the editor</div>} />);
  });
  await flush();
};
const button = (name: string) => [...host.querySelectorAll("button")].find(b => b.textContent === name) ?? null;

describe("previewKind", () => {
  it("chooses by extension, ignoring case", () => {
    expect(previewKind("docs/README.md")).toBe("markdown");
    expect(previewKind("a.MARKDOWN")).toBe("markdown");
    for (const ext of ["png", "jpg", "JPEG", "gif", "webp"]) expect(previewKind(`pic.${ext}`)).toBe("image");
    expect(previewKind("logo.svg")).toBe("svg");
  });

  it("leaves code, extensionless names and dotfiles to the text editor", () => {
    for (const path of ["src/a.ts", "Makefile", ".gitignore", "notes.md.bak", "archive.zip", "dir.md/file"]) expect(previewKind(path)).toBeNull();
  });
});

describe("sizeLabel", () => {
  it("reads in bytes, KB and MB", () => {
    expect(sizeLabel(12)).toBe("12 bytes");
    expect(sizeLabel(2048)).toBe("2.0 KB");
    expect(sizeLabel(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("markdown", () => {
  it("opens rendered, and Source hands the pane to the editor and back", async () => {
    await show("README.md");
    expect(host.querySelector('[data-preview="markdown"]')?.textContent).toContain("Some bold words");
    expect(host.querySelector("[data-source]")).toBeNull();
    await act(async () => { button("Source")?.click(); });
    expect(host.querySelector("[data-source]")).not.toBeNull();
    expect(host.querySelector('[data-preview="markdown"]')).toBeNull();
    await act(async () => { button("Preview")?.click(); });
    await flush();
    expect(host.querySelector('[data-preview="markdown"]')).not.toBeNull();
  });
});

describe("images", () => {
  it("shows the image with its size in bytes and no Source switch for a png", async () => {
    await show("pic.png");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAEC");
    expect(host.querySelector("[data-image-info]")?.textContent).toBe("2.0 KB");
    expect(button("Source")).toBeNull();
  });

  it("adds the pixel size once the image has loaded", async () => {
    await show("pic.png");
    const img = host.querySelector("img");
    if (!img) throw new Error("no image");
    Object.defineProperty(img, "naturalWidth", { value: 640 });
    Object.defineProperty(img, "naturalHeight", { value: 480 });
    await act(async () => { img.dispatchEvent(new Event("load")); });
    expect(host.querySelector("[data-image-info]")?.textContent).toBe("640 × 480 px · 2.0 KB");
  });

  it("gives an svg the Source switch too", async () => {
    await show("logo.svg");
    expect(host.querySelector("img")).not.toBeNull();
    await act(async () => { button("Source")?.click(); });
    expect(host.querySelector("[data-source]")).not.toBeNull();
  });

  it("says so, with the size, when the image is over the native cap", async () => {
    imageData = null;
    await show("huge.png");
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("too large to preview");
    expect(host.textContent).toContain("2.0 KB");
  });
});
