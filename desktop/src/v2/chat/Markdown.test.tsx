// @vitest-environment happy-dom
// #14327: the 2.0 markdown: headings, quotes, real tables, code blocks with a copy button, links that
// wait for the checkout to confirm them, and the safety the classic renderer had (no images, no HTML).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Link } from "../../shared/linkify";
import { createLinkResolver, type LinkApi } from "../../shared/linkify";
import { LinkProvider, type LinkContextValue } from "./LinkContext";
import { COPIED_MS } from "./bits";
import { Markdown } from "./Markdown";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const show = async (node: ReactNode) => { await act(async () => { root.render(node); }); };
const md = (text: string) => show(<Markdown text={text} />);
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

/** A project whose checkout holds exactly `files` and `commits`; `gate` holds the answer back until released. */
function fakeLinks(files: string[], commits: string[] = []) {
  const opened: Link[] = [];
  const release: Array<() => void> = [];
  const api: LinkApi = {
    pathsExist: (_p, paths) => new Promise(done => { release.push(() => done(paths.map(x => files.includes(x)))); }),
    commitsExist: (_p, shas) => Promise.resolve(shas.map(x => commits.includes(x))),
  };
  const value: LinkContextValue = { resolver: createLinkResolver("p", api), open: l => opened.push(l), openDiff: () => {}, locate: async () => "unknown", project: "p" };
  return { value, opened, release: () => release.splice(0).forEach(r => r()) };
}

describe("Markdown blocks", () => {
  it("renders headings by level: h1 and h2 at title, h3 at base, all semibold", async () => {
    await md("# One\n\n## Two\n\n### Three");
    const heads = [...host.querySelectorAll<HTMLElement>('[role="heading"]')];
    expect(heads.map(h => h.getAttribute("aria-level"))).toEqual(["1", "2", "3"]);
    expect(heads[0].className).toContain("text-v2-title");
    expect(heads[1].className).toContain("text-v2-title");
    expect(heads[2].className).toContain("text-v2-base");
    expect(heads.every(h => h.className.includes("font-semibold"))).toBe(true);
  });

  it("renders a blockquote with a 2px accent-edge rule in muted text", async () => {
    await md("> quoted *words*\n> second line\n\nafter");
    const q = host.querySelector("blockquote");
    expect(q?.className).toContain("border-l-2");
    expect(q?.className).toContain("border-[var(--v2-accent-edge)]");
    expect(q?.className).toContain("text-[var(--v2-muted)]");
    expect(q?.querySelector("em")?.textContent).toBe("words");
    expect(host.textContent).toContain("after");
  });

  it("renders a real table: header row, cells, numeric columns right-aligned in mono, first column medium", async () => {
    await md("| Package | Status | Tests |\n| --- | :-: | ---: |\n| desktop | passing | 1,284 |\n| cli | failing | 902 |");
    const table = host.querySelector("table");
    expect(table).not.toBeNull();
    expect(host.querySelector("pre")).toBeNull();
    expect(table?.parentElement?.className).toContain("overflow-x-auto");
    expect(table?.parentElement?.className).toContain("rounded-md");
    expect([...host.querySelectorAll("th")].map(h => h.textContent)).toEqual(["Package", "Status", "Tests"]);
    const rows = [...host.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    const first = rows[0].querySelectorAll("td");
    expect(first[0].className).toContain("font-medium");
    expect(first[1].className).toContain("text-center");
    expect(first[2].className).toContain("text-right");
    expect(first[2].className).toContain("v2-mono");
    expect(first[1].className).not.toContain("v2-mono");
  });

  it("keeps words whole in a narrow chat: label columns never wrap, prose columns keep a floor", async () => {
    // the operator's crew plan table, which rendered one letter per line ("m/e/di/u/m") in the chat column
    await md([
      "| package | diff | executor (model) | pool | est $ | reason |",
      "| --- | --- | --- | --- | --- | --- |",
      "| Foundation: image tiles, schema contract, legend | medium | orchestrator | high-sub | — | architect-owned, the orchestrator keeps the shared contract in its own hands |",
      "| Transcribe charts 38-48 to JSON | hard | deepseek | api | 0.97 | hard, strongest available coder; its api pool means real $ but cheapest capable |",
    ].join("\n"));
    const table = host.querySelector("table");
    expect(table?.className).toContain("[overflow-wrap:normal]");
    expect(table?.className).toContain("[word-break:normal]");
    expect(table?.parentElement?.className).toContain("overflow-x-auto");
    const heads = [...host.querySelectorAll("th")];
    const cells = [...host.querySelectorAll("tbody tr:first-child td")];
    for (const c of [1, 2, 3, 4]) {
      expect(heads[c].className).toContain("whitespace-nowrap");
      expect(cells[c].className).toContain("whitespace-nowrap");
    }
    for (const c of [0, 5]) {
      expect(cells[c].className).toContain("min-w-[16ch]");
      expect(cells[c].className).not.toContain("whitespace-nowrap");
    }
  });

  it("right-aligns a column of plain numbers without an explicit alignment", async () => {
    await md("a | b\n--- | ---\nx | 12\ny | 3.5%");
    const cells = [...host.querySelectorAll("tbody tr td:nth-child(2)")];
    expect(cells.every(c => c.className.includes("text-right") && c.className.includes("v2-mono"))).toBe(true);
    expect(host.querySelector("tbody tr td")?.className).toContain("text-left");
  });

  it("keeps a pipe inside backticks inside its cell", async () => {
    await md("| cmd | note |\n| --- | --- |\n| `a | b` | ok |");
    expect([...host.querySelectorAll("tbody td")].map(c => c.textContent)).toEqual(["a | b", "ok"]);
  });

  it("renders a code block with the language, a copy button and a sunken mono body", async () => {
    await md("```bash\npnpm test\ngit tag v2\n```");
    const block = host.querySelector("[data-code-block]");
    expect(block?.textContent).toContain("bash");
    expect(block?.querySelector("pre")?.textContent).toBe("pnpm test\ngit tag v2");
    expect(block?.querySelector("pre")?.className).toContain("v2-mono");
    expect(block?.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  });

  it("shows a check for a moment after the code is copied, then goes back", async () => {
    const written: string[] = [];
    const before = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } });
    try {
      await md("```\nhello\n```");
      const button = () => host.querySelector<HTMLButtonElement>('[data-code-block] button');
      await act(async () => { button()?.click(); });
      await settle();
      expect(written).toEqual(["hello"]);
      expect(button()?.getAttribute("aria-label")).toBe("Copied");
      expect(button()?.querySelector("svg")?.getAttribute("class")).toContain("lucide-check");
      await act(async () => { await new Promise(r => setTimeout(r, COPIED_MS + 100)); });
      expect(button()?.getAttribute("aria-label")).toBe("Copy code");
    } finally {
      if (before) Object.defineProperty(navigator, "clipboard", before);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("renders paragraphs, lists with nesting, and an inline code chip", async () => {
    await md("Use `pnpm test` first.\n\n- one\n  - nested\n- two\n\n1. a\n2. b");
    expect(host.querySelector("code")?.className).toContain("bg-[var(--v2-sunken)]");
    expect(host.querySelector("code")?.className).toContain("v2-mono");
    const lists = host.querySelectorAll("ul, ol");
    expect(lists.length).toBe(3);
    expect(host.querySelector("ul ul li")?.textContent).toBe("nested");
    expect(host.querySelector("ol")?.className).toContain("list-decimal");
  });

  it("never renders an image or raw HTML, and keeps a hostile link scheme as text", async () => {
    await md('![pic](https://x.test/a.png) <script>alert(1)</script> <b>bold</b> [x](javascript:alert(1))');
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
    expect(host.textContent).toContain("<script>alert(1)</script>");
    expect(host.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("stays standing under a pathological pile of openers", async () => {
    await md("*".repeat(500) + "[".repeat(500) + "> ".repeat(60) + "deep");
    expect(host.textContent).toContain("deep");
  });
});

describe("Markdown links", () => {
  it("turns a bare URL and a card id into links at once, and a markdown link opens externally", async () => {
    const { value, opened } = fakeLinks([]);
    await show(<LinkProvider value={value}><Markdown text={"See https://trantor.dev/changelog, card #14306 and [docs](https://example.com/d)."} /></LinkProvider>);
    const anchors = [...host.querySelectorAll("a")];
    expect(anchors.map(a => a.textContent)).toEqual(["https://trantor.dev/changelog", "#14306", "docs"]);
    expect(anchors.map(a => a.getAttribute("title"))).toEqual(["https://trantor.dev/changelog", "Open card #14306", "https://example.com/d"]);
    await act(async () => { anchors[1].click(); });
    expect(opened.map(l => `${l.kind}:${l.href}`)).toEqual(["card:14306"]);
  });

  it("keeps a path as plain text until the checkout confirms it, then links it at its line, in the same text", async () => {
    const fake = fakeLinks(["desktop/src/a.ts"]);
    await show(<LinkProvider value={fake.value}><Markdown text="Edited desktop/src/a.ts:42 today." /></LinkProvider>);
    expect(host.querySelector("a")).toBeNull();
    const before = host.textContent;
    await act(async () => { fake.release(); });
    await settle();
    const a = host.querySelector("a");
    expect(a?.textContent).toBe("desktop/src/a.ts:42");
    expect(a?.getAttribute("title")).toBe("Open desktop/src/a.ts at line 42");
    expect(host.textContent).toBe(before);
    await act(async () => { a?.click(); });
    expect(fake.opened[0]).toMatchObject({ kind: "path", href: "desktop/src/a.ts", line: 42 });
  });

  it("drops a path the checkout does not have back to plain text for good", async () => {
    const fake = fakeLinks([]);
    await show(<LinkProvider value={fake.value}><Markdown text="Maybe src/ghost.ts exists." /></LinkProvider>);
    await act(async () => { fake.release(); });
    await settle();
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("src/ghost.ts");
  });

  it("links a confirmed commit and a path inside inline code, titled for what a click does", async () => {
    const fake = fakeLinks(["theme.css"], ["9c1da74"]);
    await show(<LinkProvider value={fake.value}><Markdown text="Merged as 9c1da74 in `theme.css`." /></LinkProvider>);
    await act(async () => { fake.release(); });
    await settle();
    const anchors = [...host.querySelectorAll("a")];
    expect(anchors.map(a => a.getAttribute("title"))).toEqual(["Open commit 9c1da74", "Open theme.css"]);
    expect(host.querySelector("code a")?.textContent).toBe("theme.css");
  });

  it("with no host to confirm anything, candidates stay text but URLs still link", async () => {
    await md("src/a.ts and https://x.test/y");
    expect([...host.querySelectorAll("a")].map(a => a.textContent)).toEqual(["https://x.test/y"]);
  });

  it("does not nest a link inside a link's own label", async () => {
    await md("[see https://x.test/y](https://x.test/z)");
    expect(host.querySelectorAll("a")).toHaveLength(1);
  });
});
