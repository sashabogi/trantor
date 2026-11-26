// @vitest-environment happy-dom
// #14327: the scroll fade on long boxes, and the workspace's link wiring (a click routes through openLink, Open diff sets the change intent).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Link } from "../../shared/linkify";
import { takeOpenIntent, type OpenIntent } from "../shell/openIntent";
import type { OpenLinkDeps } from "../shell/openLink";
import { FadeBox } from "./bits";
import { ChatLinks, useLinks } from "./LinkContext";
import { LinkAnchor } from "./Linked";
import { Markdown } from "./Markdown";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("FadeBox", () => {
  it("fades its bottom edge only while content is hidden below, and clears at the foot", async () => {
    await act(async () => { root.render(<FadeBox max={360}><p>tall</p></FadeBox>); });
    const box = () => host.querySelector<HTMLElement>("[data-fade], .overflow-y-auto");
    expect(box()?.getAttribute("data-fade")).toBeNull();
    expect(box()?.style.maxHeight).toBe("360px");
    const el = box();
    if (!el) throw new Error("box missing");
    Object.defineProperty(el, "scrollHeight", { value: 900, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 360, configurable: true });
    await act(async () => { el.dispatchEvent(new Event("scroll")); });
    expect(el.getAttribute("data-fade")).toBe("true");
    expect(el.style.maskImage).toContain("linear-gradient");
    el.scrollTop = 540;
    await act(async () => { el.dispatchEvent(new Event("scroll")); });
    expect(el.getAttribute("data-fade")).toBeNull();
    expect(el.style.maskImage).toBe("");
  });
});

describe("ChatLinks", () => {
  const fakeDeps = () => {
    const went: string[] = [];
    const intents: OpenIntent[] = [];
    const deps: OpenLinkDeps = {
      navigate: (screen, project) => { went.push(`${screen}:${project ?? ""}`); },
      openUrl: url => { went.push(`url:${url}`); },
      revealExternalPath: () => {},
      setIntent: (_p, intent) => { intents.push(intent); },
      openCard: (_p, id) => { went.push(`card:${id}`); },
      resolvePath: async (_p, raw) => ({ path: raw, dir: false, inside: true }),
    };
    return { deps, went, intents };
  };

  it("routes a click on a link through openLink with the host's navigation", async () => {
    const { deps, went, intents } = fakeDeps();
    const link: Link = { kind: "path", href: "src/a.ts", label: "src/a.ts:7", line: 7, pending: false };
    await act(async () => {
      root.render(<ChatLinks project="p" navigate={deps.navigate} deps={deps}><LinkAnchor link={link} /></ChatLinks>);
    });
    await act(async () => { host.querySelector("a")?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(intents).toEqual([{ kind: "file", path: "src/a.ts", line: 7, col: undefined, seat: undefined }]);
    expect(went).toEqual(["code:p"]);
  });

  it("opens a card from a card link", async () => {
    const { deps, went } = fakeDeps();
    await act(async () => {
      root.render(<ChatLinks project="p" navigate={deps.navigate} deps={deps}><Markdown text="see #14306" /></ChatLinks>);
    });
    await act(async () => { host.querySelector("a")?.click(); });
    expect(went).toEqual(["card:14306"]);
  });

  it("Open diff sets the change intent for the path and goes to Code", async () => {
    const { deps, went } = fakeDeps();
    function Probe() {
      const { openDiff } = useLinks();
      return <button type="button" onClick={() => openDiff("src/b.ts")}>diff</button>;
    }
    await act(async () => { root.render(<ChatLinks project="proj-diff" navigate={deps.navigate} deps={deps}><Probe /></ChatLinks>); });
    await act(async () => { host.querySelector("button")?.click(); });
    expect(takeOpenIntent("proj-diff")).toEqual({ kind: "change", path: "src/b.ts", seat: undefined });
    expect(went).toEqual(["code:proj-diff"]);
  });
});

describe("Markdown loose lists", () => {
  it("keeps a bullet list and a numbered list that follow each other as two lists", async () => {
    await act(async () => { root.render(<Markdown text={"- a\n- b\n\n1. c\n2. d"} />); });
    expect(host.querySelectorAll("ul li")).toHaveLength(2);
    expect(host.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("keeps blank-separated items of the same kind in one list", async () => {
    await act(async () => { root.render(<Markdown text={"- a\n\n- b\n\n- c"} />); });
    expect(host.querySelectorAll("ul")).toHaveLength(1);
    expect(host.querySelectorAll("ul li")).toHaveLength(3);
  });
});
