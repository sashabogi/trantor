// @vitest-environment happy-dom
// #14365: the seat astronaut. Poses per state, compact against full parts, the one-shot sparkle, the reduced-motion
// block in theme.css, the unknown-vendor monogram, the cross-fade and the hidden-window pause.
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SeatState } from "./identity";
import { astroState, SeatAstronaut } from "./SeatAstronaut";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

type Props = Parameters<typeof SeatAstronaut>[0];
const render = (props: Partial<Props> = {}) =>
  act(async () => { root.render(<SeatAstronaut vendor="codex" state="working" name="codex-8" {...props} />); });
const box = () => host.querySelector<HTMLElement>(".v2-sa-box");
const current = () => host.querySelector<HTMLElement>('[data-layer="current"]');

describe("SeatAstronaut states", () => {
  const cases: [SeatState, string, string][] = [
    ["working", "working", "working"], ["needs", "needs you", "needs"], ["waiting", "waiting", "waiting"],
    ["ready", "ready", "ready"], ["idle", "idle", "sleeping"], ["offline", "offline", "sleeping"],
  ];
  it.each(cases)("%s reads as an image named for the seat and state, posed %s", async (state, word, pose) => {
    await render({ state });
    expect(box()?.getAttribute("role")).toBe("img");
    expect(box()?.getAttribute("data-state")).toBe(state);
    expect(box()?.getAttribute("aria-label")).toBe(`codex-8, ${word}`);
    expect(current()?.classList.contains(pose)).toBe(true);
  });

  it("maps idle and offline to the sleeping pose and keeps the rest", () => {
    expect(astroState("idle")).toBe("sleeping");
    expect(astroState("offline")).toBe("sleeping");
    expect(astroState("needs")).toBe("needs");
  });

  it("colours the antenna light with the state language and sizes the box", async () => {
    await render({ state: "waiting", size: 48, variant: "full" });
    expect(box()?.style.getPropertyValue("--st")).toBe("var(--v2-proposal)");
    expect(box()?.style.getPropertyValue("--s")).toBe("48px");
  });
});

describe("SeatAstronaut variants", () => {
  it("compact is helmet, visor and antenna with one cue: a 3-key bar when working, no hands", async () => {
    await render({ state: "working", variant: "compact" });
    expect(current()?.classList.contains("c")).toBe(true);
    expect(current()?.querySelector(".ant")).not.toBeNull();
    expect(current()?.querySelector(".vf")).not.toBeNull();
    expect(current()?.querySelectorAll(".ky")).toHaveLength(3);
    expect(current()?.querySelector(".hl, .hr, .code")).toBeNull();
    expect(current()?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 32 32");
  });

  it("full adds the body, hands, keyboard and the code scrolling on the visor", async () => {
    await render({ state: "working", variant: "full", size: 48 });
    expect(current()?.querySelector(".hl")).not.toBeNull();
    expect(current()?.querySelector(".hr")).not.toBeNull();
    expect(current()?.querySelectorAll(".ky")).toHaveLength(7);
    expect(current()?.querySelector(".code")).not.toBeNull();
    expect(current()?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 96 96");
  });

  it("compact waiting has the tap ripples and no hand; full waiting has the tapping finger", async () => {
    await render({ state: "waiting", variant: "compact" });
    expect(current()?.querySelectorAll(".rip")).toHaveLength(2);
    expect(current()?.querySelector(".tap")).toBeNull();
    await render({ state: "waiting", variant: "full" });
    expect(current()?.querySelector(".tap")).not.toBeNull();
  });

  it("each full pose has its own prop: wave, thumb, z z", async () => {
    await render({ state: "needs", variant: "full" });
    expect(current()?.querySelector(".wave")).not.toBeNull();
    await render({ state: "ready", variant: "full" });
    expect(current()?.querySelector(".thumb")).not.toBeNull();
    await render({ state: "idle", variant: "full" });
    expect(current()?.querySelectorAll(".zz")).toHaveLength(2);
  });
});

describe("SeatAstronaut vendor", () => {
  it("puts the vendor colour on the visor with its mark, and the Codex gradient for Codex", async () => {
    await render({ vendor: "claude" });
    expect(current()?.style.getPropertyValue("--v")).toBe("#D97757");
    expect(current()?.querySelector("svg.mk path")).not.toBeNull();
    await render({ vendor: "codex" });
    expect(current()?.style.getPropertyValue("--v")).toMatch(/^url\(#.+cv\)$/);
    expect(current()?.querySelector("linearGradient")).not.toBeNull();
  });

  it("an unknown harness gets a grey visor and a two-letter monogram instead of a mark", async () => {
    await render({ vendor: "adx-3", name: undefined });
    expect(current()?.style.getPropertyValue("--v")).toBe("var(--v2-track)");
    expect(current()?.querySelector("svg.mk")).toBeNull();
    expect(current()?.querySelector("text.mono-t")?.textContent).toBe("AD");
    expect(box()?.getAttribute("aria-label")).toBe("adx-3, working");
  });
});

describe("SeatAstronaut motion", () => {
  it("plays the ready sparkle only on entering ready, not on a re-render while ready", async () => {
    await render({ state: "working", variant: "full" });
    expect(host.querySelector(".spark")).toBeNull();
    await render({ state: "ready", variant: "full" });
    const spark = host.querySelector('[data-layer="current"] .spark');
    expect(spark).not.toBeNull();
    await render({ state: "ready", variant: "full", size: 64 });
    expect(host.querySelector('[data-layer="current"] .spark')).toBe(spark);
    await render({ state: "needs", variant: "full" });
    expect(host.querySelector('[data-layer="current"] .spark')).toBeNull();
  });

  it("cross-fades 180ms: the pose it left stays under the new one, then goes", async () => {
    await render({ state: "working" });
    await render({ state: "needs" });
    expect(host.querySelector('[data-layer="leaving"]')?.classList.contains("working")).toBe(true);
    expect(host.querySelector('[data-layer="current"]')?.classList.contains("fade-in")).toBe(true);
    await act(async () => { await new Promise(r => setTimeout(r, 230)); });
    expect(host.querySelector('[data-layer="leaving"]')).toBeNull();
  });

  it("pauses its animations while the window is hidden", async () => {
    await render();
    expect(box()?.hasAttribute("data-paused")).toBe(false);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(box()?.hasAttribute("data-paused")).toBe(true);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(box()?.hasAttribute("data-paused")).toBe(false);
  });
});

describe("SeatAstronaut theme.css", () => {
  const css = readFileSync("src/v2/theme.css", "utf8");
  const ours = css.slice(css.indexOf("/* #14365"));
  it("animates transform and opacity only", () => {
    const bodies = [...ours.matchAll(/@keyframes v2-sa-[\w-]+\{(.*)\}\s*$/gm)].map(m => m[1]);
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) expect(body.replace(/transform:[^;}]*|opacity:[^;}]*/g, "")).not.toMatch(/[a-z-]+:/);
  });
  it("has a reduced-motion block that stops the animation and shows static poses", () => {
    const reduced = ours.slice(ours.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".v2-sa *{animation:none !important}");
    expect(reduced).toContain(".v2-sa.c.waiting .head{transform:rotate(-8deg)}");
    expect(reduced).toContain(".v2-sa.ready .spark{opacity:1}");
    expect(reduced).toContain(".v2-sa.sleeping .zz{opacity:.85}");
  });
  it("tilts the compact waiting head on top of the ripples, and pauses when hidden", () => {
    expect(ours).toContain(".v2-sa.c.waiting .head{animation:v2-sa-tiltc 2s");
    expect(ours).toContain("[data-paused]");
  });
  it("uses only theme tokens for colour", () => {
    expect(ours.match(/#[0-9a-fA-F]{6}\b/g)).toBeNull();
  });
});
