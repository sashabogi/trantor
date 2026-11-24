// @vitest-environment happy-dom
// #13994: nav search filters sections and rows; dial dependencies hold; a dial change takes classic's CLI path.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { AutonomyPage } from "./AutonomyPage";
import { SettingsNav } from "./SettingsNav";
import { filterSections, SECTIONS } from "./sections";
import { dialBlockedBy, resetPlan, type AutonomyState, type Resolved } from "./autonomyModel";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: Resolved = { harness: "prompt", commit: true, push: false, deploy: false, swapDeadSeat: true, retryFailedTurn: true };
const stateOf = (r: Partial<Resolved>, overridden: string[] = []): AutonomyState =>
  ({ project: null, resolved: { ...base, ...r }, defaults: base, overridden, path: "~/.agent-bus/autonomy.json" });

let host: HTMLDivElement;
let root: Root;
let fakeClient: HubClient;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); fakeClient = makeClient(); });
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
function makeClient(): HubClient {
  const c = new HubClient("http://127.0.0.1:1");
  vi.spyOn(c, "policy").mockResolvedValue({ autonomy: { "*": 2 }, links: [] });
  vi.spyOn(c, "setAutonomy").mockResolvedValue({});
  return c;
}

describe("nav search", () => {
  it("filters sections by label, description and inner rows", () => {
    expect(filterSections("").length).toBe(SECTIONS.length);
    expect(filterSections("deploy").map(s => s.id)).toEqual(["autonomy"]);
    expect(filterSections("netcup").map(s => s.id)).toEqual(["hub"]);
    expect(filterSections("zzzz")).toEqual([]);
  });

  it("renders only the matching groups and says so when nothing matches", () => {
    act(() => root.render(<SettingsNav sections={filterSections("keychain")} active="accounts" query="keychain" onQuery={() => {}} onPick={() => {}} />));
    expect(host.querySelector('[data-section="accounts"]')).not.toBeNull();
    expect(host.querySelector('[data-section="general"]')).toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Crew"]')).toBeNull();
    act(() => root.render(<SettingsNav sections={[]} active="accounts" query="x" onQuery={() => {}} onPick={() => {}} />));
    expect(host.textContent).toContain("No setting matches that search.");
  });
});

describe("dial dependencies", () => {
  it("push needs commit and deploy needs push", () => {
    expect(dialBlockedBy("push", { ...base, commit: false })).toBe("commit");
    expect(dialBlockedBy("deploy", { ...base, push: false })).toBe("push");
    expect(dialBlockedBy("deploy", { ...base, push: true })).toBeNull();
    expect(dialBlockedBy("commit", { ...base, commit: false })).toBeNull();
  });

  it("closes outer dials before inner ones when resetting", () => {
    const s: AutonomyState = { ...stateOf({ commit: false, push: true, deploy: true }), defaults: { ...base, commit: true, push: true, deploy: true } };
    expect(resetPlan(s)).toEqual([{ dial: "commit", value: "on" }]);
    const t: AutonomyState = { ...stateOf({ commit: true, push: true, deploy: true }), defaults: { ...base, commit: false, push: false, deploy: false } };
    expect(resetPlan(t).map(w => w.dial)).toEqual(["deploy", "push", "commit"]);
  });

  it("disables a blocked dial with the reason in the row", async () => {
    const api = { get: vi.fn(async () => stateOf({ commit: false })), set: vi.fn() };
    act(() => root.render(<AutonomyPage client={fakeClient} project="trantor" query="" api={api} />));
    await flush();
    const push = host.querySelector('[data-dial="Push after verifying"]');
    expect(push?.textContent).toContain("Only as open as Commit landed work allows");
    expect(push?.querySelector<HTMLButtonElement>('[role="radio"]')?.disabled).toBe(true);
  });
});

describe("changing a dial", () => {
  it("writes through the same autonomy_set command classic uses", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return JSON.stringify(stateOf(cmd === "autonomy_set" ? { push: true } : {}));
    });
    act(() => root.render(<AutonomyPage client={fakeClient} project="trantor" query="" />));
    await flush();
    const on = host.querySelector<HTMLButtonElement>('[data-dial="Push after verifying"] [role="radio"][aria-checked="false"]');
    act(() => on?.click());
    await flush();
    expect(calls).toContainEqual({ cmd: "autonomy_get", args: { project: null } });
    expect(calls).toContainEqual({ cmd: "autonomy_set", args: { project: null, dial: "push", value: "on" } });
  });

  it("scopes the write to the project when This project is picked", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    mockIPC((cmd, args) => { calls.push({ cmd, args }); return JSON.stringify(stateOf({}, ["commit"])); });
    act(() => root.render(<AutonomyPage client={fakeClient} project="trantor" query="" />));
    await flush();
    const proj = [...host.querySelectorAll("button")].find(b => b.textContent === "This project: trantor");
    act(() => proj?.click());
    await flush();
    expect(calls).toContainEqual({ cmd: "autonomy_get", args: { project: "trantor" } });
    expect(host.textContent).toContain("override for trantor");
  });

  it("filters dial rows by the search query", async () => {
    mockIPC(() => JSON.stringify(stateOf({})));
    act(() => root.render(<AutonomyPage client={fakeClient} project="" query="deploy" />));
    await flush();
    expect(host.querySelector('[data-dial="Deploy after pushing"]')).not.toBeNull();
    expect(host.querySelector('[data-dial="Commit landed work"]')).toBeNull();
  });
});
