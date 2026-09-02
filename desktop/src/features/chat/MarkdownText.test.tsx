// @vitest-environment happy-dom
//
// #6005: an assistant reply that is markdown renders AS markdown — real <ul>/<li>, <strong>,
// <code>/<pre> nodes — and never shows the literal "**" / "- " syntax that sent the operator to
// the terminal. The fixture is shaped like a real orchestrator reply (a card-style summary the
// morning builds actually produce).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownText } from "./MarkdownText";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURE = [
  "Here is the **outcome**, using the `gate.exit` value:",
  "",
  "- fixed the seat tab pulse",
  "- tightened the runner gate",
  "- landed a regression test",
  "",
  "```ts",
  "const ok = gate.exit === 0;",
  "return ok;",
  "```",
  "",
  "Done.",
].join("\n");

describe("MarkdownText", () => {
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

  it("renders a list, bold, inline code, and a fenced block as real elements", () => {
    act(() => root.render(<MarkdownText text={FIXTURE} />));
    expect(host.querySelector("ul")).not.toBeNull();
    expect(host.querySelectorAll("li").length).toBe(3);
    expect(host.querySelector("strong")?.textContent).toBe("outcome");
    // inline `code` and the fenced <pre> are both present
    expect(host.querySelector("code")?.textContent).toBe("gate.exit");
    expect(host.querySelector("pre")?.textContent).toContain("const ok");
  });

  it("never shows the literal markdown syntax (** or the - markers)", () => {
    act(() => root.render(<MarkdownText text={FIXTURE} />));
    const text = host.textContent ?? "";
    expect(text).not.toContain("**");
    expect(text).not.toContain("- fixed");
    expect(text).not.toContain("```");
  });

  it("a reply that ends inside a fence still renders the code opened so far", () => {
    // Mid-stream (the watcher appends rows while a turn runs): the reply may end inside a fence.
    act(() => root.render(<MarkdownText text={"```ts\nconst x = 1;"} />));
    expect(host.querySelector("pre")?.textContent).toContain("const x = 1;");
  });

  it("user-style plain prose with no markers stays readable as a paragraph", () => {
    act(() => root.render(<MarkdownText text={"No formatting here at all."} />));
    expect(host.querySelector("p")?.textContent).toBe("No formatting here at all.");
    expect(host.querySelectorAll("pre, ul, strong, code").length).toBe(0);
  });

  it("numbered lists render as <ol>, headings demote to a bold line, italic renders", () => {
    act(() => root.render(<MarkdownText text={"## Result\n\n1. first\n2. second\n\nsome *emphasis* here"} />));
    expect(host.querySelector("ol")).not.toBeNull();
    expect(host.querySelectorAll("ol li").length).toBe(2);
    // no <h2> element: headings are demoted to a bold line, not a louder heading
    expect(host.querySelector("h1, h2, h3")).toBeNull();
    const boldLine = host.querySelector("p.font-semibold");
    expect(boldLine?.textContent).toBe("Result");
    expect(host.querySelector("em")?.textContent).toBe("emphasis");
  });

  it("an http link renders as an anchor to the shell opener, and is not an <img>", () => {
    act(() => root.render(<MarkdownText text={"see [the repo](https://example.com/a?q=1) for more"} />));
    const a = host.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/a?q=1");
    expect(a?.textContent).toBe("the repo");
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).not.toContain("https://example.com/a?q=1");
  });

  it("an image's markdown never becomes an <img> and its alt text stays out", () => {
    act(() => root.render(<MarkdownText text={"a ![pic](https://x/y.png) inline"} />));
    expect(host.querySelector("img")).toBeNull();
    const text = (host.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text).toContain("a inline");
    expect(text).not.toContain("![pic]");
    expect(text).not.toContain("pic");
  });

  it("40 nested *, **, [ openers with no closers renders without throwing and keeps the text (#6113)", () => {
    // The inline parser recurses once per nesting level (strong/em/link content each re-enter
    // `inline`). A reply carrying dozens of unclosed openers in a row is exactly the pathological
    // input a depth cap guards against — past the cap the remaining text renders as plain text
    // instead of recursing further, so this must neither throw nor lose the payload.
    const kinds = ["*", "**", "["];
    const openers = Array.from({ length: 40 }, (_, i) => kinds[i % kinds.length]).join("");
    const text = `${openers}PAYLOAD`;
    expect(() => act(() => root.render(<MarkdownText text={text} />))).not.toThrow();
    expect(host.textContent ?? "").toContain("PAYLOAD");
  });

  it("a pipe table renders as one monospace block", () => {
    act(() => root.render(<MarkdownText text={"| step | state |\n| --- | --- |\n| 1 | done |\n| 2 | pending |"} />));
    const pre = host.querySelector("pre");
    expect(pre?.textContent).toContain("step | state");
    expect(pre?.textContent).toContain("2 | pending");
  });

  it("a realistic reply with a nested list, prose and links parses without losing words", () => {
    const reply = [
      "Pushed **everything**.",
      "",
      "- `crew-runner` now reports turn state",
      "  - working · kickoff at turn start",
      "  - idle when the turn lands",
      "- the app pulses from the hub status",
      "",
      "See [the commit](https://github.com/x) for the diff.",
    ].join("\n");
    act(() => root.render(<MarkdownText text={reply} />));
    const text = (host.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text).toContain("Pushed everything");
    expect(text).toContain("working · kickoff at turn start");
    expect(text).toContain("idle when the turn lands");
    expect(text).toContain("the app pulses from the hub status");
    expect(text).toContain("the commit for the diff");
    expect(text).not.toContain("**");
    expect(host.querySelectorAll("ul li").length).toBe(4);   // outer 2 + nested 2
  });
});
