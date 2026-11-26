// @vitest-environment happy-dom
// A project wears its own art when its repo ships some (project_icon), the monogram otherwise.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ProjectTile } from "./ProjectTile";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ART = "data:image/png;base64,iVBORw0KGgo=";
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // Each test uses its own project name: the icon cache is module-level by design.
  mockIPC((cmd, payload) => {
    if (cmd !== "project_icon") return null;
    // SAFETY: project_icon is invoked with { project }.
    return (payload as { project: string }).project.startsWith("art-") ? ART : null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove(); clearMocks();
});
const show = async (node: React.ReactNode) => {
  await act(async () => { root.render(node); });
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });
};

describe("ProjectTile art", () => {
  it("shows the repo's own icon when project_icon finds one, and keeps the corner dot", async () => {
    await show(<ProjectTile name="art-one" dot="needs-you" />);
    const tile = host.querySelector('[data-project-tile="art-one"]');
    expect(tile?.getAttribute("data-art")).toBe("repo");
    expect(tile?.querySelector("img")?.getAttribute("src")).toBe(ART);
    expect(tile?.textContent).toBe("");
    expect(host.querySelector('[data-dot="needs-you"]')).not.toBeNull();
  });

  it("keeps the monogram when the repo has no art", async () => {
    await show(<ProjectTile name="plain-two" />);
    const tile = host.querySelector('[data-project-tile="plain-two"]');
    expect(tile?.getAttribute("data-art")).toBe("monogram");
    expect(tile?.textContent).toBe("PT");
  });

  it("falls back to the monogram when the image cannot be decoded", async () => {
    await show(<ProjectTile name="art-broken" />);
    const img = host.querySelector('[data-project-tile="art-broken"] img');
    expect(img).not.toBeNull();
    await act(async () => { img?.dispatchEvent(new Event("error")); });
    const tile = host.querySelector('[data-project-tile="art-broken"]');
    expect(tile?.getAttribute("data-art")).toBe("monogram");
    expect(tile?.textContent).toBe("AB");
  });
});
