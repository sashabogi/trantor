import { describe, expect, it } from "vitest";
import type { Link } from "../../shared/linkify";
import type { Screen } from "../routes";
import type { OpenIntent } from "./openIntent";
import { openLink, type OpenLinkDeps, type ResolvedPath } from "./openLink";

function harness(resolved: ResolvedPath | null = null) {
  const log: string[] = [];
  const intents: { project: string; intent: OpenIntent }[] = [];
  const deps: OpenLinkDeps = {
    navigate: (screen: Screen, project?: string) => { log.push(`navigate:${screen}:${project ?? ""}`); },
    openUrl: url => { log.push(`url:${url}`); },
    revealExternalPath: path => { log.push(`reveal:${path}`); },
    setIntent: (project, intent) => { intents.push({ project, intent }); },
    openCard: (project, id) => { log.push(`card:${project}:${id}`); },
    resolvePath: async (project, raw) => { log.push(`resolve:${project}:${raw}`); return resolved; },
  };
  return { deps, log, intents };
}

const link = (kind: Link["kind"], href: string, extra: Partial<Link> = {}): Link => ({ kind, href, label: href, pending: false, ...extra });

describe("openLink", () => {
  it("a url goes to the browser and nowhere else", async () => {
    const h = harness();
    await openLink("trantor", link("url", "https://a.dev/x"), h.deps);
    expect(h.log).toEqual(["url:https://a.dev/x"]);
    expect(h.intents).toEqual([]);
  });

  it("a card opens the card sheet without leaving the screen", async () => {
    const h = harness();
    await openLink("trantor", link("card", "14327"), h.deps);
    expect(h.log).toEqual(["card:trantor:14327"]);
    expect(h.intents).toEqual([]);
  });

  it("a commit leaves a commit intent and goes to Code, in the seat's scope", async () => {
    const h = harness();
    await openLink("trantor", link("commit", "9fabcb92"), h.deps, "codex-8");
    expect(h.intents).toEqual([{ project: "trantor", intent: { kind: "commit", sha: "9fabcb92", seat: "codex-8" } }]);
    expect(h.log).toEqual(["navigate:code:trantor"]);
  });

  it("a file in the checkout opens at its line and column, by its checkout-relative name", async () => {
    const h = harness({ path: "desktop/src/a.ts", dir: false, inside: true });
    await openLink("trantor", link("path", "/Users/me/trantor/desktop/src/a.ts", { line: 42, col: 7 }), h.deps);
    expect(h.log).toEqual(["resolve:trantor:/Users/me/trantor/desktop/src/a.ts", "navigate:code:trantor"]);
    expect(h.intents).toEqual([{ project: "trantor", intent: { kind: "file", path: "desktop/src/a.ts", line: 42, col: 7, seat: undefined } }]);
  });

  it("a file without a line opens plainly", async () => {
    const h = harness({ path: "a.ts", dir: false, inside: true });
    await openLink("trantor", link("path", "a.ts"), h.deps);
    expect(h.intents[0]?.intent).toEqual({ kind: "file", path: "a.ts", line: undefined, col: undefined, seat: undefined });
  });

  it("a folder is revealed in the explorer", async () => {
    const h = harness({ path: "desktop/src", dir: true, inside: true });
    await openLink("trantor", link("path", "desktop/src", { line: 3 }), h.deps, "codex-8");
    expect(h.intents).toEqual([{ project: "trantor", intent: { kind: "folder", path: "desktop/src", seat: "codex-8" } }]);
    expect(h.log).toContain("navigate:code:trantor");
  });

  it("a path outside the checkout is only revealed in Finder, never opened, and not in Code", async () => {
    const h = harness({ path: "/Users/me/notes.md", dir: false, inside: false });
    await openLink("trantor", link("path", "~/notes.md"), h.deps);
    expect(h.log).toEqual(["resolve:trantor:~/notes.md", "reveal:/Users/me/notes.md"]);
    expect(h.intents).toEqual([]);
  });

  it("a url that is not http or https is never handed to the opener", async () => {
    const h = harness(null);
    await openLink("trantor", link("url", "file:///Applications/Calculator.app"), h.deps);
    await openLink("trantor", link("url", "javascript:alert(1)"), h.deps);
    expect(h.log).toEqual([]);
  });

  it("a path that no longer resolves does nothing", async () => {
    const h = harness(null);
    await openLink("trantor", link("path", "gone.ts"), h.deps);
    expect(h.log).toEqual(["resolve:trantor:gone.ts"]);
    expect(h.intents).toEqual([]);
  });
});
