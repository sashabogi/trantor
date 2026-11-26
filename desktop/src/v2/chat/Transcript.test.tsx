// @vitest-environment happy-dom
// #14327: the 2.0 transcript: the user bubble and its prompt attributes, tool groups closed until asked,
// failed rows that open themselves, edit cards, a finished turn's fold, worked time, reply copy, the Latest pill.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Block, ToolResult, Turn } from "../../features/chat/streaming";
import { LatestPill } from "./LatestPill";
import { LinkProvider, type LinkContextValue } from "./LinkContext";
import { Transcript } from "./Transcript";
import { workedFor } from "./WorkedFooter";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const show = async (node: ReactNode) => { await act(async () => { root.render(node); }); };
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const text = (t: string): Block => ({ kind: "text", text: t });
const tool = (id: string, name: string, body: string, extra: Partial<Block> = {}): Block => ({ kind: "tool", tool: name, text: body, tool_id: id, ...extra });
const ok = (id: string, extra: Partial<ToolResult> = {}): ToolResult => ({ tool_id: id, ok: true, preview: "", ...extra });
const user = (t: string, ts?: number): Turn => ({ role: "user", blocks: [text(t)], ts });
const agent = (blocks: Block[], ts?: number): Turn => ({ role: "assistant", blocks, ts });
const results = (...rs: ToolResult[]): Record<string, ToolResult> => Object.fromEntries(rs.map(r => [r.tool_id, r]));

const reads = [1, 2, 3].map(n => tool(`r${n}`, "Read", `src/f${n}.ts`, { tool_kind: "explore", paths: [`/repo/src/f${n}.ts`] }));
const readResults = results(ok("r1"), ok("r2"), ok("r3"));

describe("UserMessage", () => {
  it("is a right-aligned bubble that keeps every prompt attribute the timeline reads", async () => {
    await show(<Transcript turns={[user("fix the login form", 1000), agent([text("Done. More detail.")], 2000), user("thanks", 9000)]} results={{}} />);
    const bubbles = [...host.querySelectorAll<HTMLElement>("[data-prompt-id]")];
    expect(bubbles.map(b => b.getAttribute("data-prompt-id"))).toEqual(["0.0", "2.0"]);
    expect(bubbles[0].getAttribute("data-prompt-ts")).toBe("1000");
    expect(bubbles[0].getAttribute("data-prompt-reply")).toBe("Done. More detail.");
    expect(bubbles[0].getAttribute("data-prompt-worked-ms")).toBe("1000");
    expect(bubbles[0].textContent).toBe("fix the login form");
    expect(bubbles[0].parentElement?.className).toContain("rounded-br-sm");
    expect(bubbles[0].parentElement?.parentElement?.className).toContain("items-end");
  });

  it("lists the files a prompt's reply changed", async () => {
    const edit = tool("e1", "Edit", "a.ts", { tool_kind: "edit", path: "src/a.ts", paths: ["/repo/src/a.ts"] });
    await show(<Transcript turns={[user("go", 1), agent([edit, text("ok")], 2)]} results={results(ok("e1"))} />);
    expect(JSON.parse(host.querySelector("[data-prompt-id]")?.getAttribute("data-prompt-files") ?? "[]")).toEqual(["src/a.ts"]);
  });

  it("clips a long message behind Show all, and Show less folds it back", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    await show(<Transcript turns={[user(long)]} results={{}} />);
    const body = host.querySelector<HTMLElement>("[data-prompt-id]");
    expect(body?.style.overflow).toBe("hidden");
    const more = [...host.querySelectorAll("button")].find(b => b.textContent === "Show all");
    expect(more).toBeDefined();
    await click(more ?? null);
    expect(host.querySelector<HTMLElement>("[data-prompt-id]")?.style.overflow).toBe("");
    expect([...host.querySelectorAll("button")].some(b => b.textContent === "Show less")).toBe(true);
  });

  it("does not offer Show all for a short message", async () => {
    await show(<Transcript turns={[user("short")]} results={{}} />);
    expect(host.querySelector("button")).toBeNull();
  });

  it("marks a queued message", async () => {
    await show(<Transcript turns={[{ ...user("later"), queued: true }]} results={{}} />);
    expect(host.textContent).toContain("queued");
  });
});

describe("tool rows", () => {
  it("folds a run of calls into one summary row, closed by default, and opens on a click", async () => {
    await show(<Transcript turns={[user("go"), agent(reads)]} results={readResults} working />);
    const header = [...host.querySelectorAll("button")].find(b => b.textContent === "Explored 3 files");
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll('[data-testid="tool-row"]')).toHaveLength(0);
    await click(header ?? null);
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll('[data-testid="tool-row"]')).toHaveLength(3);
  });

  it("shows a lone call as a verb and its object, closed until clicked", async () => {
    await show(<Transcript turns={[user("go"), agent([tool("b1", "Bash", "pnpm test", { tool_kind: "command" })])]} results={results(ok("b1", { exit_code: 0, duration_ms: 1500, preview: "all green" }))} working />);
    const row = host.querySelector('[data-testid="tool-row"]');
    expect(row?.textContent).toContain("Ran");
    expect(row?.textContent).toContain("pnpm test");
    expect(host.querySelector('[data-testid="tool-detail"]')).toBeNull();
    await click(row?.querySelector("button") ?? null);
    expect(host.querySelector('[data-testid="tool-detail"]')?.textContent).toContain("all green");
    expect(host.querySelector('[data-testid="exit-chip"]')?.textContent).toBe("exit 0");
    expect(host.querySelector('[data-testid="exit-chip"]')?.getAttribute("data-ok")).toBe("true");
    expect(host.querySelector('[data-testid="tool-detail"]')?.textContent).toContain("1.5s");
  });

  it("opens a failed command by itself with its exit chip, time and output, and a Show output button when it is long", async () => {
    const long = Array.from({ length: 20 }, (_, i) => `out ${i}`).join("\n");
    const failed = tool("b2", "Bash", "pnpm test --filter hub", { tool_kind: "command" });
    await show(<Transcript turns={[user("go"), agent([failed])]} results={results({ tool_id: "b2", ok: false, preview: long, exit_code: 1, duration_ms: 14_200 })} working />);
    const row = host.querySelector('[data-testid="tool-row"]');
    expect(row?.getAttribute("data-state")).toBe("failed");
    expect(row?.textContent).toContain("Couldn't run");
    const chip = host.querySelector('[data-testid="exit-chip"]');
    expect(chip?.textContent).toBe("exit 1");
    expect(chip?.getAttribute("data-ok")).toBeNull();
    expect(host.querySelector('[data-testid="tool-detail"]')?.textContent).toContain("14.2s");
    expect(host.querySelector('[data-testid="tool-detail"]')?.textContent).not.toContain("out 19");
    const more = [...host.querySelectorAll("button")].find(b => b.textContent === "Show output");
    await click(more ?? null);
    expect(host.querySelector('[data-testid="tool-detail"]')?.textContent).toContain("out 19");
  });

  it("pulses the icon of a call still running and words it from the summary", async () => {
    await show(<Transcript turns={[user("go"), agent([tool("b3", "Bash", "sleep 9", { tool_kind: "command" })])]} results={{}} working />);
    const row = host.querySelector('[data-testid="tool-row"]');
    expect(row?.getAttribute("data-state")).toBe("running");
    expect(row?.querySelector(".v2-pulse")).not.toBeNull();
    expect(row?.textContent).toContain("Running…");
    expect(row?.textContent).toContain("sleep 9");
  });

  it("draws a landed edit as a card with +N -M, tinted diff lines, and Open diff on its path", async () => {
    const opened: string[] = [];
    const links: LinkContextValue = { resolver: null, open: () => {}, openDiff: p => opened.push(p), locate: async () => "inside", project: "trantor" };
    const edit = tool("e2", "Edit", "Composer2.tsx", {
      tool_kind: "edit", path: "desktop/Composer2.tsx", paths: ["/repo/desktop/Composer2.tsx"], added: 12, removed: 3,
      diff: [{ op: "-", text: "old()" }, { op: "+", text: "new()" }],
    });
    await show(<LinkProvider value={links}><Transcript turns={[user("go"), agent([edit])]} results={results(ok("e2"))} working /></LinkProvider>);
    const card = host.querySelector('[data-testid="edit-card"]');
    expect(card?.textContent).toContain("Composer2.tsx");
    expect(host.querySelector('[data-testid="edit-added"]')?.textContent).toBe("+12");
    expect(host.querySelector('[data-testid="edit-removed"]')?.textContent).toBe("-3");
    const lines = [...card?.querySelectorAll("[data-op]") ?? []];
    expect(lines.map(l => l.textContent)).toEqual(["- old()", "+ new()"]);
    expect(lines[0].className).toContain("bg-[var(--v2-diff-del)]");
    expect(lines[1].className).toContain("bg-[var(--v2-diff-add)]");
    await click([...card?.querySelectorAll("button") ?? []].find(b => b.textContent === "Open diff") ?? null);
    expect(opened).toEqual(["/repo/desktop/Composer2.tsx"]);
  });

  it("labels an edit to a file outside the project, which Source Control never shows, and offers no diff", async () => {
    const asked: string[] = [];
    const links: LinkContextValue = {
      resolver: null, open: () => {}, openDiff: () => {}, project: "trantor",
      locate: async p => { asked.push(p); return "outside"; },
    };
    const edit = tool("e9", "Write", "chat-fix1.md", {
      tool_kind: "write", path: "/private/tmp/scratch/chat-fix1.md", paths: ["/private/tmp/scratch/chat-fix1.md"], added: 51, removed: 0,
    });
    await show(<LinkProvider value={links}><Transcript turns={[user("go"), agent([edit])]} results={results(ok("e9"))} working /></LinkProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(asked).toEqual(["/private/tmp/scratch/chat-fix1.md"]);
    const label = host.querySelector('[data-testid="edit-outside"]');
    expect(label?.textContent).toBe("outside trantor");
    expect(label?.getAttribute("title")).toContain("does not show in Source Control");
    const card = host.querySelector('[data-testid="edit-card"]');
    expect([...card?.querySelectorAll("button") ?? []].some(b => b.textContent === "Open diff")).toBe(false);
  });

  it("makes a read's object a link to its file", async () => {
    const opened: string[] = [];
    const links: LinkContextValue = { resolver: null, open: l => opened.push(l.href), openDiff: () => {}, locate: async () => "unknown", project: "trantor" };
    const one = [tool("r9", "Read", "src/one.ts", { tool_kind: "explore", paths: ["/repo/src/one.ts"] })];
    await show(<LinkProvider value={links}><Transcript turns={[user("go"), agent(one)]} results={results(ok("r9"))} working /></LinkProvider>);
    const a = host.querySelector('[data-testid="tool-row"] a');
    expect(a?.textContent).toBe("src/one.ts");
    await click(a);
    expect(opened).toEqual(["/repo/src/one.ts"]);
  });

  it("renders an answered question read-only", async () => {
    const ask: Block = { kind: "tool", tool: "AskUserQuestion", text: "", tool_id: "q1", ask: [{ header: "Pick", question: "Which?", multiSelect: false, options: [] }] };
    await show(<Transcript turns={[user("go"), agent([ask])]} results={results(ok("q1", { preview: "Option A" }))} working />);
    expect(host.querySelector('[data-testid="asked-row"]')?.textContent).toContain("Option A");
  });
});

describe("a finished turn", () => {
  const blocks = [...reads, tool("b9", "Bash", "ls", { tool_kind: "command" }), text("All done, here is the answer.")];
  const every = { ...readResults, ...results(ok("b9")) };

  it("folds the work before the reply into one row with a trailing hairline, and expands to the items", async () => {
    await show(<Transcript turns={[user("go"), agent(blocks)]} results={every} />);
    const fold = [...host.querySelectorAll("button")].find(b => b.textContent?.startsWith("Explored 3 files, ran 1 command"));
    expect(fold).toBeDefined();
    expect(host.querySelector('[data-testid="fold-trail"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="tool-row"]')).toHaveLength(0);
    expect(host.textContent).toContain("All done, here is the answer.");
    await click(fold ?? null);
    expect(host.querySelectorAll('[data-testid="tool-row"], [aria-expanded]').length).toBeGreaterThan(1);
  });

  it("keeps the work unfolded while the turn is still being written", async () => {
    await show(<Transcript turns={[user("go"), agent(blocks)]} results={every} working />);
    expect(host.querySelector('[data-testid="fold-trail"]')).toBeNull();
    expect([...host.querySelectorAll("button")].some(b => b.textContent === "Explored 3 files, ran 1 command")).toBe(true);
  });
});

describe("WorkedFooter", () => {
  const turns = (ms: number) => [user("go", 1_000), agent([text("done")], 1_000 + ms)];

  it("formats minutes with a padded second", () => {
    expect([42_000, 365_000, 3_720_000].map(workedFor)).toEqual(["42s", "6m 05s", "1h 02m"]);
  });

  it("reads Worked for 6m 05s under a finished reply", async () => {
    await show(<Transcript turns={turns(365_000)} results={{}} />);
    expect(host.querySelector('[data-testid="worked-footer"]')?.textContent).toBe("Worked for 6m 05s");
  });

  it("is hidden under five seconds", async () => {
    await show(<Transcript turns={turns(4_000)} results={{}} />);
    expect(host.querySelector('[data-testid="worked-footer"]')).toBeNull();
  });

  it("waits until the turn is finished", async () => {
    await show(<Transcript turns={turns(365_000)} results={{}} working />);
    expect(host.querySelector('[data-testid="worked-footer"]')).toBeNull();
  });

  it("is drawn once per prompt, under its last agent turn", async () => {
    const split: Turn[] = [user("go", 1_000), agent([text("first part")], 20_000), { role: "system", blocks: [{ kind: "divider", text: "compacted" }] }, agent([text("second part")], 61_000)];
    await show(<Transcript turns={split} results={{}} />);
    expect(host.querySelectorAll('[data-testid="worked-footer"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="worked-footer"]')?.textContent).toBe("Worked for 1m 00s");
  });
});

describe("ReplyActions", () => {
  it("copies the whole reply as markdown and shows a check", async () => {
    const written: string[] = [];
    const before = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } });
    try {
      await show(<Transcript turns={[user("go"), agent([text("Narration."), tool("r1", "Read", "a.ts", { tool_kind: "explore" }), text("## Result\n\nIt works.")])]} results={results(ok("r1"))} />);
      const pills = host.querySelectorAll('[data-testid="reply-actions"]');
      expect(pills).toHaveLength(1);
      expect(pills[0].className).toContain("opacity-0");
      expect(pills[0].className).toContain("group-hover:opacity-100");
      expect(pills[0].className).toContain("focus-within:opacity-100");
      const copy = pills[0].querySelector("button");
      expect(copy?.getAttribute("aria-label")).toBe("Copy reply");
      await click(copy ?? null);
      await settle();
      expect(written).toEqual(["Narration.\n\n## Result\n\nIt works."]);
      expect(copy?.getAttribute("aria-label")).toBe("Copied");
    } finally {
      if (before) Object.defineProperty(navigator, "clipboard", before);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

describe("layout", () => {
  it("draws dividers as quiet centred lines, and zooms for the reading size", async () => {
    const turns: Turn[] = [{ role: "system", blocks: [{ kind: "divider", text: "session continued" }] }];
    await show(<Transcript turns={turns} results={{}} scale={1.1} />);
    expect(host.textContent).toBe("session continued");
    expect(host.querySelector<HTMLElement>('[data-testid="transcript"]')?.style.zoom).toBe("1.1");
  });

  it("gutters 12px and 16px from 420, with turns 8px apart", async () => {
    await show(<Transcript turns={[user("a"), agent([text("b")])]} results={{}} />);
    const inner = host.querySelector('[data-testid="transcript"]')?.firstElementChild;
    expect(host.querySelector('[data-testid="transcript"]')?.className).toContain("@container");
    expect(inner?.className).toContain("px-3");
    expect(inner?.className).toContain("@[420px]:px-4");
    expect(inner?.className).toContain("gap-2");
    expect(inner?.className).toContain("pt-3");
    expect(inner?.className).toContain("pb-2");
  });
});

describe("LatestPill", () => {
  it("says Latest, or N new once messages landed below, and jumps on a click", async () => {
    let jumps = 0;
    await show(<LatestPill unseen={0} onClick={() => { jumps++; }} />);
    const pill = () => host.querySelector<HTMLButtonElement>('[data-testid="latest-pill"]');
    expect(pill()?.textContent).toBe("Latest");
    expect(pill()?.getAttribute("aria-label")).toBe("Jump to latest");
    expect(pill()?.className).toContain("rounded-full");
    expect(pill()?.className).toContain("v2-pop");
    await click(pill());
    expect(jumps).toBe(1);
    await show(<LatestPill unseen={3} onClick={() => {}} />);
    expect(pill()?.textContent).toBe("3 new");
    expect(pill()?.getAttribute("aria-label")).toBe("Jump to latest — new messages below");
  });
});
