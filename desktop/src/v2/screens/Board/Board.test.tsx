// @vitest-environment happy-dom
// #13989: the Board screen against a fake hub client: lanes, filters, the Done gate, the drawer.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubClient, type Card, type Peer } from "../../../shared/api/client";
import { BoardScreen } from "./index";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 864e5;
type Row = Card & { drill?: string };
const row = (id: number, status: string, extra: Partial<Row> = {}): Row =>
  ({ id, project: "p", title: `card number ${id}`, status, updated: Date.now() - 60_000, ...extra });

const CARDS: Row[] = [
  row(1, "todo"),
  row(2, "doing", { assignee: "codex-8" }),
  row(3, "testing", { assignee: "glm-5", drill: "open the app" }),
  row(4, "testing", { assignee: "codex-8" }),
  row(5, "testing", { assignee: "glm-5", updated: Date.now() - 10 * DAY }),
  row(6, "done"),
  row(7, "failed"),
];
const PEERS: Peer[] = [{ session: "codex-8", project: "p", lastSeen: Date.now() }, { session: "glm-5", project: "p", lastSeen: Date.now() - 120_000 }];

type Reply = { tasks: Row[] } | { peers: Peer[] } | { task: Row | Partial<Row> | undefined; events: []; messages: [] } | { ok: boolean; task?: Row } | Record<string, never>;
type Call ={ method: string; path: string; body: unknown };
/** A REAL HubClient over a fake transport: only the event stream is stubbed (it needs Tauri). */
class TestHub extends HubClient {
  streamEvents() { return () => {}; }
}

function fakeClient(over: { full?: Partial<Row> } = {}) {
  const calls: Call[] = [];
  const transport = async ({ method, path, body }: { method: string; path: string; body: string | null }) => {
    calls.push({ method, path, body: body ? JSON.parse(body) : null });
    const ok = (v: Reply) => ({ status: 200, body: JSON.stringify(v) });
    if (path.startsWith("/tasks")) return ok({ tasks: CARDS });
    if (path.startsWith("/peers")) return ok({ peers: PEERS });
    if (path.startsWith("/card?id=")) {
      const id = Number(path.split("=")[1]);
      return ok({ task: { ...CARDS.find(c => c.id === id), checklist: [{ text: "first item", done: false }], ...over.full }, events: [], messages: [] });
    }
    if (path === "/task/checklist-toggle") return ok({ ok: true, task: CARDS[0] });
    return ok({});
  };
  const client = new TestHub("http://hub.test", transport);
  const posted = (path: string) => calls.filter(c => c.method === "POST" && c.path === path).map(c => c.body);
  return { client, posted };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
async function mount(client: HubClient) {
  await act(async () => { root.render(<BoardScreen client={client} project="p" onNavigate={() => {}} />); });
  await flush();
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const buttonByText = (t: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim().startsWith(t));
const click = (el: Element | undefined | null) => act(async () => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const type = (el: HTMLInputElement, v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("BoardScreen lanes", () => {
  it("renders the four lanes, splits testing in three groups and collapses failed to a strip", async () => {
    await mount(fakeClient().client);
    for (const l of ["To do", "Doing", "Testing", "Done"]) expect(q(`section[aria-label="${l}"]`)).not.toBeNull();
    const testing = q('section[aria-label="Testing"]')!;
    expect(testing.textContent).toContain("NEEDS YOUR DRILL");
    expect(testing.textContent).toContain("GATE RUNNING");
    expect(testing.textContent).toContain("OLDER THAN 7 DAYS");
    expect(testing.querySelector('[data-card="3"]')).not.toBeNull();
    expect(testing.querySelector('[data-card="4"]')).not.toBeNull();
    expect(testing.querySelector('[data-card="5"]')).toBeNull();
    expect(q('button[aria-label="Failed, 1"]')).not.toBeNull();
    expect(q('section[aria-label="Blocked"]')).toBeNull();
    await click(buttonByText("▸OLDER") ?? buttonByText("▸ OLDER") ?? [...host.querySelectorAll("button")].find(b => b.textContent?.includes("OLDER THAN")));
    expect(q('[data-card="5"]')).not.toBeNull();
  });

  it("puts the one next-step button on the card face", async () => {
    await mount(fakeClient().client);
    expect(q('[data-card="1"]')?.textContent).toContain("Assign");
    expect(q('[data-card="2"]')?.textContent).toContain("Watch");
    expect(q('[data-card="3"]')?.textContent).toContain("Run drill");
    expect(q('[data-card="3"]')?.textContent).toContain("drill");
  });

  it("leaves New card disabled with its reason, and Has a PR disabled", async () => {
    await mount(fakeClient().client);
    const nc = buttonByText("New card");
    expect(nc?.disabled).toBe(true);
    expect(nc?.title).toMatch(/not wired/i);
    expect(buttonByText("Has a PR")?.disabled).toBe(true);
  });
});

describe("BoardScreen filters", () => {
  it("filters by #id text search", async () => {
    await mount(fakeClient().client);
    await type(host.querySelector<HTMLInputElement>("#v2-board-search")!, "#4");
    expect(q('[data-card="4"]')).not.toBeNull();
    expect(q('[data-card="2"]')).toBeNull();
  });

  it("Needs you keeps the idle testing card and drops the busy one", async () => {
    await mount(fakeClient().client);
    await click(buttonByText("Needs you"));
    expect(q('[data-card="3"]')).not.toBeNull();
    expect(q('[data-card="4"]')).toBeNull();
    expect(q('[data-card="2"]')).toBeNull();
  });

  it("filters by seat avatar", async () => {
    await mount(fakeClient().client);
    await click(q('button[aria-label="Filter by codex-8"]'));
    expect(q('[data-card="2"]')).not.toBeNull();
    expect(q('[data-card="3"]')).toBeNull();
  });

  it("shows 8 seat avatars and a +N that expands the rest (#13984 drill)", async () => {
    const many = Array.from({ length: 11 }, (_, i) => row(100 + i, "todo", { assignee: `seat-${i + 1}` }));
    CARDS.push(...many);
    try {
      await mount(fakeClient().client);
      const avatars = () => host.querySelectorAll('[aria-label="Filter by seat"] button[aria-pressed]').length;
      const plus = [...host.querySelectorAll("button")].find(b => /^\+\d+$/.test(b.textContent ?? ""));
      expect(avatars()).toBe(8);
      expect(plus?.textContent).toBe("+5");
      expect(q('button[aria-label="Filter by codex-8"]')?.getAttribute("title")).toBe("codex-8, 2 open cards");
      await click(plus ?? null);
      expect(avatars()).toBe(13);
    } finally { CARDS.length -= many.length; }
  });

  it("List works as a table and Dependencies shows not wired", async () => {
    await mount(fakeClient().client);
    await click(buttonByText("List"));
    expect(host.querySelectorAll("tr[data-row]").length).toBe(CARDS.length);
    await click(buttonByText("Dependencies"));
    expect(host.textContent).toMatch(/not wired/i);
  });
});

describe("BoardScreen drawer", () => {
  it("opens the drawer for a card with its tabs", async () => {
    const { client } = fakeClient();
    await mount(client);
    await click(q('[data-card="3"] button[aria-label="Open card #3"]'));
    await flush();
    const drawer = q('aside[aria-label="Card #3"]');
    expect(drawer).not.toBeNull();
    for (const t of ["Overview", "Code", "Story", "Timeline"]) expect([...drawer!.querySelectorAll('[role="tab"]')].some(b => b.textContent?.startsWith(t))).toBe(true);
    expect(drawer!.textContent).toContain("open the app");
  });

  it("refuses Done with its reason when the card has no drill line", async () => {
    const { client, posted } = fakeClient({ full: { drill: undefined } });
    await mount(client);
    await click(q('[data-card="4"] button[aria-label="Open card #4"]'));
    await flush();
    const done = [...q('aside[aria-label="Card #4"]')!.querySelectorAll("button")].find(b => b.textContent === "Done");
    expect(done?.disabled).toBe(true);
    expect(done?.title).toMatch(/drill line/);
    await click(done);
    expect(posted("/task/update")).toEqual([]);
  });

  it("moves to done when a drill line exists, and toggles acceptance items", async () => {
    const { client, posted } = fakeClient();
    await mount(client);
    await click(q('[data-card="3"] button[aria-label="Open card #3"]'));
    await flush();
    const drawer = q('aside[aria-label="Card #3"]')!;
    await click(drawer.querySelector('input[type="checkbox"]'));
    expect(posted("/task/checklist-toggle")).toEqual([{ id: 3, index: 0, done: true }]);
    await click([...drawer.querySelectorAll("button")].find(b => b.textContent === "Done"));
    expect(posted("/task/update")).toEqual([{ id: 3, status: "done" }]);
  });

  it("closes from the labelled close button", async () => {
    await mount(fakeClient().client);
    await click(q('[data-card="1"] button[aria-label="Open card #1"]'));
    await flush();
    await click(q('button[aria-label="Close card"]'));
    expect(q('aside[aria-label="Card #1"]')).toBeNull();
  });
});
