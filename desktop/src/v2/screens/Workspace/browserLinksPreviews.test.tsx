// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ChatLinks } from "../../chat/LinkContext";
import { LinkAnchor } from "../../chat/Linked";
import { Markdown } from "../../chat/Markdown";
import type { OpenLinkDeps } from "../../shell/openLink";
import { openInBrowserTab } from "../../shell/openInBrowserTab";
import { EMPTY_BROWSER_STATE } from "./browserModel";
import { previewScanner, createPreviewStore, previewNote, previewStore } from "./previewStore";
import { previewTerminalDeps } from "./PreviewTerminal";
import { Tabs } from "../../ui/Tabs";
import { usePreviews } from "./usePreviews";
import { PreviewChip } from "./PreviewChip";
import { makeTerminalDouble } from "../../../features/workspace/terminalDouble";

// SAFETY: React uses this flag only to enable act diagnostics in the DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearMocks(); });

describe("B4 chat links", () => {
  it("routes plain markdown and autolinks into the project browser, Cmd-click externally, paths into Code", async () => {
    const calls: string[] = [];
    const deps: OpenLinkDeps = {
      navigate: screen => { calls.push(screen); }, openUrl: url => { calls.push(`external:${url}`); },
      revealExternalPath: () => {}, setIntent: () => {}, openCard: () => {},
      resolvePath: async () => ({ path: "src/a.ts", dir: false, inside: true }),
    };
    await act(async () => root.render(<ChatLinks project="b4" navigate={deps.navigate} deps={deps}
      browserOpen={async (project, url) => { calls.push(`${project}:${url}`); }}>
      <Markdown text="[preview](http://localhost:5173/) https://example.com" />
      <LinkAnchor link={{ kind: "path", href: "src/a.ts", label: "file", pending: false }} />
    </ChatLinks>));
    const anchors = host.querySelectorAll("a");
    await act(async () => { anchors[0].click(); anchors[1].click(); });
    await act(async () => { anchors[0].dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })); });
    await act(async () => { anchors[2].click(); });
    expect(calls).toEqual(["b4:http://localhost:5173/", "b4:https://example.com", "external:http://localhost:5173/", "code"]);
  });

  it("creates the first page, navigates an existing page, and reveals only after the command succeeds", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    let hasPage = false;
    mockIPC((command, args) => {
      if (command === "browser_state") return { ...EMPTY_BROWSER_STATE, pages: hasPage ? [{ id: "one" }] : [] };
      calls.push({ command, args });
    });
    await openInBrowserTab("p", "http://localhost:5173/");
    expect(calls.map(c => c.command)).toEqual(["browser_new_page", "plugin:event|emit"]);
    expect(calls[0].args).toEqual({ project: "p", url: "http://localhost:5173/" });
    expect(calls[1].args).toEqual({ event: "browser://reveal", payload: { project: "p" } });
    calls.length = 0;
    hasPage = true;
    await openInBrowserTab("p", "https://example.com");
    expect(calls.map(c => c.command)).toEqual(["browser_navigate", "plugin:event|emit"]);
    calls.length = 0;
    await openInBrowserTab("p", "javascript:alert(1)");
    expect(calls).toEqual([]);
    mockIPC(command => {
      if (command === "browser_state") return EMPTY_BROWSER_STATE;
      calls.push({ command, args: null });
      throw new Error("browser unavailable");
    });
    await expect(openInBrowserTab("p", "https://example.com")).rejects.toThrow("browser unavailable");
    expect(calls.map(c => c.command)).toEqual(["browser_new_page"]);
  });
});

describe("B4 terminal previews", () => {
  it("detects coloured, split localhost/loopback lines once per URL and ignores non-local addresses and invalid ports", () => {
    const found: string[] = [];
    const scan = previewScanner((url, tool) => found.push(`${tool}:${url}`));
    scan("VITE v6 ready in 412ms\n  ➜ Local: \x1b[34mhttp://local");
    scan("host:51");
    expect(found).toEqual([]);
    scan("73/\x1b[0m\nready on http://127.0.0.1:3000\n");
    scan("Local: http://localhost:5173/\nhttp://example.com:4000\nhttp://localhost:99999/\n");
    expect(found).toEqual(["vite:http://localhost:5173/", "vite:http://127.0.0.1:3000/"]);
  });

  it("passes original bytes through, isolates projects and seats, and stops on surface disappearance rather than detach", async () => {
    const store = createPreviewStore();
    const terminal = makeTerminalDouble();
    let present = true;
    const deps = previewTerminalDeps("p", "codex-8", { ...terminal.deps,
      surfaceFor: async () => ({ surface: present ? "pane" : null, machine: null }),
    }, store);
    const received: number[] = [];
    await deps.termAttach("pane", bytes => { received.push(...new Uint8Array(bytes instanceof ArrayBuffer ? bytes : Array.from(bytes))); });
    const bytes = new TextEncoder().encode("VITE\nLocal: http://localhost:5173/\n");
    terminal.emitBytes(bytes);
    expect(received).toEqual(Array.from(bytes));
    expect(store.read("p")).toHaveLength(1);
    expect(previewNote(store.read("p")[0])).toContain("vite, started by codex-8");
    expect(store.read("other")).toEqual([]);
    store.detect("p", "glm-5", "glm-5", "http://localhost:3000/", "next");
    await deps.termDetach(42);
    expect(store.read("p").every(p => p.running)).toBe(true);
    present = false;
    await deps.surfaceFor("p", "codex-8");
    expect(store.read("p").map(p => p.running)).toEqual([false, true]);
    expect(previewNote(store.read("p")[0])).toContain("stopped");
    terminal.emitBytes(bytes);
    expect(store.read("p")).toHaveLength(2);
  });

  it("offers a chip once, retaining the preview after opening and deduping terminal replays", async () => {
    const project = "b4-chip";
    const url = "http://localhost:6789/";
    previewStore.detect(project, "seat", "seat", url, "vite");
    const calls: string[] = [];
    function Offers() {
      const previews = usePreviews(project);
      return <Tabs label="Seats" pane="var(--v2-bg)" activeId="seat" onSelect={() => {}} stacked tabs={[{
        id: "seat", label: "seat", beside: previews.filter(p => p.offered).map(p => <PreviewChip key={p.url} project={project} preview={p}
          open={async (projectName, u) => { calls.push(`${projectName}:${u}`); }} />),
      }]} />;
    }
    await act(async () => root.render(<Offers />));
    const chip = [...host.querySelectorAll("button")].find(b => b.textContent === "Open in Browser tab");
    expect(chip).toBeDefined();
    expect(chip?.closest("[role=tab]")).toBeNull();
    await act(async () => chip?.click());
    expect(host.textContent).not.toContain("Open in Browser tab");
    expect(calls).toEqual([`${project}:${url}`]);
    previewStore.detect(project, "seat", "seat", url, "vite");
    expect(previewStore.read(project)).toHaveLength(1);
    expect(previewStore.read(project)[0]).toMatchObject({ running: true, offered: false });
  });
});
