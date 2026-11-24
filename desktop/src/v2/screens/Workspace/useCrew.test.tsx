// @vitest-environment happy-dom
// #13987 drill: a seat-catalog failure belongs to the project that raised it and never follows the operator to another.
// The fake sits at the Tauri IPC (workspace_cli), keyed by the project the screen asks for.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useCrew } from "./useCrew";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS = JSON.stringify({ agents: [] });
const BALANCES = JSON.stringify({ balances: [] });
let broken: Set<string>;
let asked: string[];
let host: HTMLDivElement;
let root: Root;

function Probe({ project }: { project: string }) {
  const crew = useCrew(project, () => undefined);
  return <p data-notice={crew.notice ? (crew.notice.failed ? "red" : "quiet") : "none"}>{crew.notice?.text ?? ""}</p>;
}

beforeEach(() => {
  broken = new Set();
  asked = [];
  mockIPC((command, payload) => {
    if (command !== "workspace_cli") return null;
    // SAFETY: mockIPC types payload as unknown; workspace_cli is invoked with { project, args }.
    const { project, args } = payload as { project: string; args: string[] };
    asked.push(`${project}:${args[0]}`);
    if (broken.has(project)) throw `No local checkout for ${project}`;
    return args[0] === "balances" ? BALANCES : SETTINGS;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearMocks(); });

const show = async (project: string) => {
  await act(async () => { root.render(<Probe project={project} />); });
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });
};
const note = () => host.querySelector("p");

describe("seat catalog", () => {
  it("asks for the project on screen and nothing else", async () => {
    await show("trantor");
    expect(new Set(asked.map(a => a.split(":")[0]))).toEqual(new Set(["trantor"]));
    expect(note()?.dataset.notice).toBe("none");
  });

  it("does not carry another project's missing checkout over when the operator switches projects", async () => {
    broken.add("Ember");
    await show("Ember");
    expect(note()?.textContent).toContain("No local checkout for Ember");
    await show("trantor");
    expect(note()?.dataset.notice).toBe("none");
    expect(note()?.textContent).toBe("");
  });

  it("still shows a real failure for this project, quietly, with the reason", async () => {
    broken.add("trantor");
    await show("trantor");
    expect(note()?.dataset.notice).toBe("quiet");
    expect(note()?.textContent).toBe("Seat catalog unavailable for trantor: No local checkout for trantor");
  });
});
