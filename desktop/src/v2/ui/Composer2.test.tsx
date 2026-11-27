// @vitest-environment happy-dom
// #v2-F: the composer is controlled, sends on Enter, and every control says what it is.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer2, type Choice, type Composer2Props } from "./Composer2";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const EFFORTS: readonly Choice[] = [
  { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" }, { value: "max", label: "Max" },
];
const PERMISSIONS: readonly Choice[] = [
  { value: "ask", label: "Ask me", icon: "lock", description: "Prompts wait for you." },
  { value: "auto", label: "Full auto", icon: "zap", tone: "warn", description: "Runs without asking." },
];
const MODELS: readonly Choice[] = [
  { value: "opus", label: "Opus", description: "Complex work" }, { value: "sonnet", label: "Sonnet", description: "Simpler tasks" },
];

function Harness({ onSend, extra, picks }: { onSend: (t: string) => void; extra?: Partial<Composer2Props>; picks?: string[] }) {
  const [value, setValue] = useState("");
  const [effort, setEffort] = useState<string | null>("low");
  const [permission, setPermission] = useState("ask");
  const log = (kind: string, set: (v: string) => void) => (v: string) => { picks?.push(`${kind}:${v}`); set(v); };
  return (
    <Composer2 value={value} onChange={setValue} onSend={t => { onSend(t); setValue(""); }}
      label="Message the orchestrator" agent="orchestrator" model={{ id: "claude-opus-5-5", label: "Opus 5.5" }}
      modelChoices={MODELS} modelValue="opus" onModelChange={log("model", () => {})}
      effort={effort} effortChoices={EFFORTS} onEffortChange={log("effort", setEffort)}
      permission={permission} permissionChoices={PERMISSIONS} onPermissionChange={log("permission", setPermission)}
      contextPct={48} onAttach={() => {}} {...extra} />
  );
}

const q = (sel: string) => host.querySelector<HTMLElement>(sel);
function type(text: string) {
  const ta = host.querySelector("textarea");
  if (!ta) throw new Error("no textarea");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => { setter?.call(ta, text); ta.dispatchEvent(new Event("input", { bubbles: true })); });
  return ta;
}

describe("Composer2", () => {
  it("isolates the soft glow behind the rounded container and leaves the field without a ring", () => {
    act(() => root.render(<Harness onSend={() => {}} />));
    const composer = q("[data-v2-composer]");
    expect(composer?.classList.contains("v2-composer")).toBe(true);
    expect(composer?.classList.contains("isolate")).toBe(true);
    expect(composer?.className).not.toMatch(/ring|overflow-hidden/);
    expect(composer?.classList.contains("rounded-xl")).toBe(true);
    expect(composer?.contains(host.querySelector("textarea"))).toBe(true);
    expect(host.querySelector("textarea")?.className).not.toMatch(/outline|ring/);
    expect(q("[data-group=agent] button")?.className).toContain("h-6");
    expect(q("[data-group=agent] button")?.className).toContain("bg-transparent");
  });

  it("shows an aria-hidden top-edge sweep only while busy", () => {
    act(() => root.render(<Harness onSend={() => {}} extra={{ busy: true }} />));
    expect(q("[data-v2-composer] > .v2-composer-sweep")?.getAttribute("aria-hidden")).toBe("true");
    expect(q(".v2-composer-sweep > .v2-sweep")).not.toBeNull();
    act(() => root.render(<Harness onSend={() => {}} extra={{ busy: false }} />));
    expect(q(".v2-composer-sweep")).toBeNull();
  });

  it("starts at two rows and grows to fit the text, up to a ceiling (#14254)", () => {
    const heightOf = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");
    let content = 0;
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => content });
    try {
      act(() => root.render(<Harness onSend={() => {}} />));
      const box = host.querySelector("textarea");
      expect(box?.getAttribute("rows")).toBe("2");
      expect(box?.style.height).toBe("auto");
      content = 96;
      expect(type("one\ntwo\nthree\nfour").style.height).toBe("96px");
      content = 900;
      expect(type("a very long draft").style.height).toBe("240px");
    } finally {
      if (heightOf) Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", heightOf);
    }
  });

  it("labels the text box and keeps send disabled until there is text", () => {
    act(() => root.render(<Harness onSend={vi.fn()} />));
    const ta = host.querySelector("textarea");
    expect(host.querySelector(`label[for="${ta?.id}"]`)?.textContent).toBe("Message the orchestrator");
    expect(q('button[aria-label="Send"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("sends the trimmed text on Enter and keeps Shift+Enter for a new line", () => {
    const onSend = vi.fn();
    act(() => root.render(<Harness onSend={onSend} />));
    const ta = type("  ship it  ");
    act(() => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })); });
    expect(onSend).not.toHaveBeenCalled();
    act(() => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onSend).toHaveBeenCalledWith("ship it");
    expect(host.querySelector("textarea")?.value).toBe("");
  });

  // #14487: one action slot, two states — while the parent says a turn runs (onStop set) the
  // button is Stop and Esc in the box rides the same interrupt.
  it("swaps Send for Stop while onStop is set, and Esc stops too", () => {
    const onStop = vi.fn();
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ busy: true, onStop }} />));
    const stop = q('button[aria-label="Stop"]');
    expect(stop).not.toBeNull();
    expect(q('button[aria-label="Send"]')).toBeNull();
    expect(stop?.title).toBe("Interrupt this turn (Esc)");
    act(() => stop?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    const ta = host.querySelector("textarea");
    if (!ta) throw new Error("no textarea");
    act(() => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("shows Send again once onStop is gone, and Esc is just a key then", () => {
    const onStop = vi.fn();
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ busy: true, onStop }} />));
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ busy: false }} />));
    expect(q('button[aria-label="Stop"]')).toBeNull();
    expect(q('button[aria-label="Send"]')).not.toBeNull();
    act(() => { host.querySelector("textarea")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("puts the paperclip right before the round send button", () => {
    act(() => root.render(<Harness onSend={vi.fn()} />));
    const send = q('button[aria-label="Send"]');
    expect(send?.previousElementSibling?.getAttribute("aria-label")).toBe("Attach a file or image");
    expect(send?.className).toContain("rounded-full");
  });

  it("opens a permission menu that lists every level with what it does, and sets the one clicked", () => {
    const picks: string[] = [];
    act(() => root.render(<Harness onSend={vi.fn()} picks={picks} />));
    expect(q('[role="menu"]')).toBeNull();
    act(() => q('button[aria-label="orchestrator, permission: Ask me"]')?.click());
    const rows = [...host.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')];
    expect(rows.map(r => r.textContent)).toEqual(["Ask mePrompts wait for you.", "Full autoRuns without asking."]);
    expect(rows[0].getAttribute("aria-checked")).toBe("true");
    act(() => rows[1].click());
    expect(picks).toEqual(["permission:auto"]);
    expect(q('[role="menu"]')).toBeNull();
    expect(q('button[aria-label="orchestrator, permission: Full auto"]')).not.toBeNull();
  });

  it("sets effort to the level clicked in one step, never by cycling, and lists the models", () => {
    const picks: string[] = [];
    act(() => root.render(<Harness onSend={vi.fn()} picks={picks} />));
    const chip = () => q('button[aria-label^="Model: Opus 5.5"]');
    expect(chip()?.getAttribute("aria-label")).toBe("Model: Opus 5.5, effort: Low");
    expect(chip()?.querySelectorAll("[data-lit]").length).toBe(1);
    act(() => chip()?.click());
    const levels = [...host.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Effort"] [role="radio"]')];
    expect(levels.map(l => l.textContent)).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
    act(() => levels[4].click());
    expect(picks).toEqual(["effort:max"]);
    expect(chip()?.getAttribute("aria-label")).toBe("Model: Opus 5.5, effort: Max");
    expect(chip()?.querySelectorAll("[data-lit]").length).toBe(5);
    const models = [...host.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')];
    expect(models.map(m => m.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    act(() => models[1].click());
    expect(picks).toEqual(["effort:max", "model:sonnet"]);
    expect(q('svg[role="img"] text')?.textContent).toBe("48");
  });

  it("shows no effort or permission where the agent has none, instead of an invented value", () => {
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ effort: undefined, permission: undefined, modelChoices: undefined }} />));
    expect(q('[data-group="model"]')?.textContent).toBe("Opus 5.5");
    expect(q('[data-group="model"]')?.tagName).toBe("SPAN");
    expect(q('[data-group="agent"]')?.getAttribute("aria-label")).toBe("Answers: orchestrator");
    expect(host.querySelector("[data-lit]")).toBeNull();
  });

  // #14022: the live mode sits above the permission level, built only from the choices given.
  const MODES: readonly Choice[] = [
    { value: "default", label: "Agent", short: "Agent", icon: "hand", description: "Asks before edits." },
    { value: "plan", label: "Plan", short: "Plan", icon: "plan", description: "Plans first." },
  ];
  const modeMenu = () => {
    act(() => q('[data-group="agent"] button')?.click());
    return [...host.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')];
  };

  it("renders a Mode section above the permission level, from the choices, with the read mode on the chip", () => {
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ mode: "plan", modeChoices: MODES, onModeChange: () => Promise.resolve() }} />));
    expect(q('[data-group="agent"] button')?.getAttribute("aria-label")).toBe("orchestrator, mode: Plan, permission: Ask me");
    expect(q('[data-group="agent"] button')?.textContent).toContain("Plan");
    const rows = modeMenu();
    const headings = [...host.querySelectorAll('[role="menu"] div')].map(d => d.textContent);
    expect(headings.indexOf("Mode")).toBeLessThan(headings.indexOf("Permission level for orchestrator"));
    expect(rows.map(r => r.textContent)).toEqual(["AgentAsks before edits.", "PlanPlans first.", "Ask mePrompts wait for you.", "Full autoRuns without asking."]);
    expect(rows.map(r => r.getAttribute("aria-checked"))).toEqual(["false", "true", "true", "false"]);
  });

  it("calls the mode handler once, shows the row busy, and ignores clicks until it settles", async () => {
    let settle = () => {};
    const onModeChange = vi.fn((_: string) => new Promise<void>(r => { settle = r; }));
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ mode: "default", modeChoices: MODES, onModeChange }} />));
    const rows = modeMenu();
    act(() => rows[1].click());
    expect(rows[1].getAttribute("aria-busy")).toBe("true");
    expect(rows[1].querySelector('[aria-label="Switching"]')).not.toBeNull();
    act(() => rows[1].click());
    act(() => rows[0].click());
    expect(onModeChange).toHaveBeenCalledTimes(1);
    expect(onModeChange).toHaveBeenCalledWith("plan");
    await act(async () => { settle(); await Promise.resolve(); });
    expect(q('[role="menu"]')).toBeNull();
  });

  it("says Mode unknown when the mode could not be read and keeps the menu usable", () => {
    const onModeChange = vi.fn(() => Promise.resolve());
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ mode: null, modeChoices: MODES, onModeChange }} />));
    expect(q('[data-group="agent"] button')?.textContent).toContain("Mode unknown");
    const rows = modeMenu();
    act(() => rows[0].click());
    expect(onModeChange).toHaveBeenCalledWith("default");
  });

  it("says Reading mode during the boot retry window instead of Mode unknown", () => {
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ mode: null, modeReading: true, modeChoices: MODES, onModeChange: () => Promise.resolve() }} />));
    expect(q('[data-group="agent"] button')?.textContent).toContain("Reading mode…");
    expect(q('[data-group="agent"] button')?.textContent).not.toContain("Mode unknown");
  });

  it("renders no Mode section without mode props", () => {
    act(() => root.render(<Harness onSend={vi.fn()} />));
    expect(modeMenu()).toHaveLength(2);
    expect([...host.querySelectorAll('[role="menu"] div')].map(d => d.textContent)).not.toContain("Mode");
  });

  it("renders read-only labels without handlers, hides the ring without data, and explains a blocked send", () => {
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ onEffortChange: undefined, onModelChange: undefined, contextPct: null, onAttach: undefined, disabledReason: "Seat is offline" }} />));
    expect(q('[data-group="model"]')?.tagName).toBe("SPAN");
    expect(q('svg[aria-label^="Context"]')).toBeNull();
    expect(q('button[aria-label="Attach a file or image"]')).toBeNull();
    type("hello");
    const send = q('button[aria-label="Send"]');
    expect(send?.hasAttribute("disabled")).toBe(true);
    expect(send?.title).toBe("Seat is offline");
  });
});
