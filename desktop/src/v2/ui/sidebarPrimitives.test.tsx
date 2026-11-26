// @vitest-environment happy-dom
// #14344: the sidebar's own primitives: ListRow, GroupHeader, SplitButton, NoteCard and the filled Seg.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GroupHeader } from "./GroupHeader";
import { ListRow, rowIndent } from "./ListRow";
import { NoteCard } from "./NoteCard";
import { Seg } from "./Seg";
import { SplitButton } from "./SplitButton";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const firstRow = () => host.querySelector<HTMLElement>("div") ?? document.createElement("div");
const render = (node: ReactNode) => act(async () => { root.render(node); });
const click = (el: Element | null | undefined) => act(async () => { if (el instanceof HTMLElement) el.click(); });

describe("ListRow", () => {
  it("is 24px with the 8px start padding and 12px per depth level", async () => {
    expect(rowIndent(0)).toBe(8);
    expect(rowIndent(2)).toBe(32);
    await render(<ListRow depth={2} name="a.ts" />);
    const row = firstRow();
    expect(row.className).toContain("h-6");
    expect(row.className).toContain("gap-1.5");
    expect(row.style.paddingLeft).toBe("32px");
  });

  it("lets the meta truncate before the name, and an explicit indent beats the depth", async () => {
    await render(<ListRow indent={22} name="Transcript.tsx" meta="desktop/src/v2/screens" trailing={<span>+24</span>} end={<span>M</span>} />);
    const spans = [...host.querySelectorAll("span")];
    const name = spans.find(s => s.textContent === "Transcript.tsx");
    const meta = spans.find(s => s.textContent === "desktop/src/v2/screens");
    // the name keeps its width (only a very long one truncates, past 70%); the folder fills and goes first
    expect(name?.className).toContain("shrink-0");
    expect(name?.className).toContain("max-w-[70%]");
    expect(meta?.className).toContain("flex-1");
    expect(meta?.className).toContain("truncate");
    expect(meta?.className).toContain("--v2-faint");
    expect(firstRow().style.paddingLeft).toBe("22px");
    expect(host.firstElementChild?.lastElementChild?.textContent).toBe("M");
  });

  it("hides the actions column until hover, focus or selection, and keeps it in the layout", async () => {
    await render(<ListRow name="a.ts" actions={<button type="button">x</button>} />);
    const actions = host.querySelector("[data-row-actions]");
    for (const cls of ["invisible", "group-hover:visible", "group-focus-within:visible", "group-data-[selected=true]:visible"]) {
      expect(actions?.className).toContain(cls);
    }
    expect(actions?.className).not.toContain("hidden ");
  });

  it("marks the selected row for the accent fill and bar, and the hover token", async () => {
    await render(<ListRow name="a.ts" selected />);
    const row = firstRow();
    expect(row.getAttribute("data-selected")).toBe("true");
    expect(row.className).toContain("data-[selected=true]:bg-[var(--v2-accent-soft)]");
    expect(row.className).toContain("data-[selected=true]:before:bg-[var(--v2-accent)]");
    expect(row.className).toContain("before:w-0.5");
    expect(row.className).toContain("hover:bg-[var(--v2-row-hover)]");
    expect(row.className).toContain("has-[:focus-visible]:outline-[var(--v2-accent)]");
  });

  it("makes the left cluster one button that takes aria and clicks, leaving the actions outside it", async () => {
    let clicked = 0;
    await render(<ListRow name="a.ts" main={{ onClick: () => { clicked += 1; }, "aria-pressed": true, title: "Open a.ts" }} actions={<button type="button">act</button>} />);
    const main = host.querySelector<HTMLButtonElement>('button[title="Open a.ts"]');
    expect(main?.getAttribute("aria-pressed")).toBe("true");
    expect(main?.contains(host.querySelector("[data-row-actions]"))).toBe(false);
    await click(main);
    expect(clicked).toBe(1);
  });

  it("passes a role and aria through the shell", async () => {
    await render(<ListRow name="a.ts" shell={{ role: "listitem", "aria-label": "row a" }} />);
    expect(host.querySelector('[role="listitem"]')?.getAttribute("aria-label")).toBe("row a");
  });
});

describe("GroupHeader", () => {
  it("is 26px with a count, aria-expanded, a caret that turns 90deg when open, and the section hooks", async () => {
    let toggled = 0;
    await render(<GroupHeader section="staged" title="Staged" count={3} open onToggle={() => { toggled += 1; }} />);
    const toggle = host.querySelector<HTMLButtonElement>('button[data-section-toggle="staged"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.title).toBe("Hide Staged");
    expect(toggle?.querySelector("[data-count]")?.textContent).toBe("3");
    expect(toggle?.querySelector("svg")?.getAttribute("style")).toContain("rotate(90deg)");
    expect(toggle?.querySelector("svg")?.getAttribute("style")).toContain("var(--v2-dur-1)");
    expect(toggle?.parentElement?.className).toContain("h-[26px]");
    await click(toggle);
    expect(toggled).toBe(1);
  });

  it("shows its text actions only on hover, in the link colour, and a disabled one says why", async () => {
    let ran = 0;
    await render(<GroupHeader section="changes" title="Changes" open={false} onToggle={() => undefined}
      actions={[{ label: "Stage all", onClick: () => { ran += 1; } }, { label: "Unstage all", onClick: () => undefined, disabledReason: "Nothing is staged" }]} />);
    const stage = [...host.querySelectorAll("button")].find(b => b.textContent === "Stage all");
    expect(stage?.parentElement?.className).toContain("invisible");
    expect(stage?.parentElement?.className).toContain("group-hover:visible");
    expect(stage?.className).toContain("--v2-link");
    expect(host.querySelector('button[data-section-toggle="changes"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('button[data-section-toggle="changes"] svg')?.getAttribute("style") ?? "").not.toContain("rotate");
    await click(stage);
    expect(ran).toBe(1);
    const off = [...host.querySelectorAll("button")].find(b => b.textContent === "Unstage all");
    expect(off?.disabled).toBe(true);
    expect(off?.title).toBe("Nothing is staged");
  });
});

describe("SplitButton", () => {
  const items = [{ label: "Commit and push", onSelect: () => undefined }, { label: "Undo", onSelect: () => undefined, disabledReason: "Already pushed" }];

  it("runs the primary on its own and opens the menu from the chevron", async () => {
    let primary = 0;
    await render(<SplitButton label="Commit 3 files" onPrimary={() => { primary += 1; }} menuLabel="More commit actions" items={items} hint={<kbd>⌘↵</kbd>} />);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    await click([...host.querySelectorAll("button")].find(b => b.textContent?.startsWith("Commit 3 files")));
    expect(primary).toBe(1);
    await click(host.querySelector('button[aria-label="More commit actions"]'));
    expect(host.querySelector('button[aria-label="More commit actions"]')?.getAttribute("aria-expanded")).toBe("true");
    expect([...host.querySelectorAll('[role="menuitem"]')].map(i => i.textContent)).toEqual(["Commit and push", "Undo"]);
  });

  it("a menu item runs and closes the menu, a disabled one explains itself and does nothing", async () => {
    let picked = 0;
    await render(<SplitButton label="Commit" onPrimary={() => undefined} menuLabel="More" items={[{ label: "Go", onSelect: () => { picked += 1; } }, items[1]]} />);
    await click(host.querySelector('button[aria-label="More"]'));
    const undo = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(i => i.textContent === "Undo");
    expect(undo?.disabled).toBe(true);
    expect(undo?.title).toBe("Already pushed");
    await click([...host.querySelectorAll('[role="menuitem"]')].find(i => i.textContent === "Go"));
    expect(picked).toBe(1);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("disables the primary with the reason in its title, but keeps the menu reachable", async () => {
    await render(<SplitButton label="Commit" onPrimary={() => undefined} disabledReason="Write a commit message first" menuLabel="More" items={items} />);
    const primary = [...host.querySelectorAll("button")].find(b => b.textContent === "Commit");
    expect(primary?.disabled).toBe(true);
    expect(primary?.title).toBe("Write a commit message first");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="More"]')?.disabled).toBe(false);
  });
});

describe("NoteCard", () => {
  it("is a warn-tinted note with one action link", async () => {
    let went = 0;
    await render(<NoteCard note="ready" action={{ label: "Review", onClick: () => { went += 1; } }}>codex-8 has 3 files ready</NoteCard>);
    const note = host.querySelector('[role="note"]');
    expect(note?.getAttribute("data-note")).toBe("ready");
    expect(note?.className).toContain("--v2-warn-soft");
    expect(note?.className).toContain("--v2-warn-edge");
    expect(note?.className).toContain("rounded-lg");
    expect(note?.className).toContain("px-2.5");
    expect(note?.className).toContain("py-2");
    expect(note?.textContent).toContain("codex-8 has 3 files ready");
    await click(note?.querySelector("button"));
    expect(went).toBe(1);
  });

  it("without an action it is only text", async () => {
    await render(<NoteCard>just a line</NoteCard>);
    expect(host.querySelector("button")).toBeNull();
  });
});

describe("Seg, filled", () => {
  const options = [{ value: "changes", label: "Changes" }, { value: "files", label: "Files" }] as const;

  it("spans the row with equal segments and slides its thumb to the choice over 180ms", async () => {
    let value: "changes" | "files" = "changes";
    const view = () => <Seg fill label="View" options={options} value={value} onChange={v => { value = v; }} />;
    await render(view());
    const thumb = () => host.querySelector<HTMLElement>("[data-seg-thumb]");
    expect(host.querySelector<HTMLElement>('[role="group"]')?.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
    expect(thumb()?.style.transform).toBe("translateX(0%)");
    expect(thumb()?.style.transition).toContain("var(--v2-dur-2)");
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "Files"));
    await render(view());
    expect(value).toBe("files");
    expect(thumb()?.style.transform).toBe("translateX(100%)");
    expect([...host.querySelectorAll("button")].find(b => b.textContent === "Files")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("the plain Seg is unchanged: no thumb", async () => {
    await render(<Seg label="View" options={options} value="changes" onChange={() => undefined} />);
    expect(host.querySelector("[data-seg-thumb]")).toBeNull();
  });
});
