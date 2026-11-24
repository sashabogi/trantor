// @vitest-environment happy-dom
// #v2-F: the small primitives render their contract: names, tones, required labels, states.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "./Avatar";
import { ProjectTile } from "./ProjectTile";
import { Chip } from "./Chip";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Ring } from "./Ring";
import { Seg } from "./Seg";
import { Section } from "./Section";
import { Kbd } from "./Kbd";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (node: ReactNode) => act(() => { root.render(node); });

describe("Avatar", () => {
  it("wears the vendor's mark when the seat has one, a monogram otherwise", () => {
    render(<Avatar name="sasha" />);
    expect(host.querySelector('[role="img"]')?.textContent).toBe("SA");
    render(<Avatar name="orchestrator" llm="claude" />);
    expect(host.querySelector('[data-brand="Claude"]')).not.toBeNull();
    render(<Avatar name="codex-8" presence="needs-you" />);
    const img = host.querySelector('[role="img"]');
    expect(img?.querySelector('[data-brand="Codex"]')).not.toBeNull();
    expect(img?.getAttribute("aria-label")).toBe("codex-8, needs you");
    expect(host.querySelector('[data-presence="needs-you"]')).not.toBeNull();
  });

  it("has no dot without presence", () => {
    render(<Avatar name="orchestrator" />);
    expect(host.querySelector("[data-presence]")).toBeNull();
    expect(host.textContent).toBe("OR");
  });
});

describe("ProjectTile", () => {
  it("renders the project monogram, decorative, with an optional dot", () => {
    render(<ProjectTile name="crebral-cortex" dot="needs-you" />);
    const tile = host.querySelector('[data-project-tile="crebral-cortex"]');
    expect(tile?.textContent).toBe("CC");
    expect(tile?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector('[data-dot="needs-you"]')).not.toBeNull();
  });
});

describe("Chip", () => {
  it("carries its tone", () => {
    render(<Chip tone="warn">95%</Chip>);
    expect(host.querySelector('[data-tone="warn"]')?.textContent).toBe("95%");
  });
});

describe("Button", () => {
  it("is a real button that fires onClick", () => {
    const onClick = vi.fn();
    render(<Button variant="primary" onClick={onClick}>Add seat</Button>);
    const b = host.querySelector("button");
    expect(b?.getAttribute("type")).toBe("button");
    act(() => b?.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("disables with a reason in the hover title", () => {
    const onClick = vi.fn();
    render(<Button disabledReason="after the extension-host spike" onClick={onClick} title="Install">Install</Button>);
    const b = host.querySelector("button");
    expect(b?.disabled).toBe(true);
    expect(b?.title).toBe("after the extension-host spike");
    act(() => b?.click());
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("IconButton", () => {
  it("always has an aria-label and a title, and a badge when counted", () => {
    render(<IconButton label="Notifications, 6 need you" title="Notifications" badge={6}><svg /></IconButton>);
    const b = host.querySelector("button");
    expect(b?.getAttribute("aria-label")).toBe("Notifications, 6 need you");
    expect(b?.title).toBe("Notifications");
    expect(host.querySelector("[data-badge]")?.textContent).toBe("6");
  });

  it("hides a zero badge", () => {
    render(<IconButton label="Inbox" title="Inbox" badge={0}><svg /></IconButton>);
    expect(host.querySelector("[data-badge]")).toBeNull();
  });
});

describe("Ring", () => {
  it("prints the percent inside and stays accent below 75", () => {
    render(<Ring pct={48} />);
    const svg = host.querySelector("svg");
    expect(svg?.getAttribute("aria-label")).toBe("Context 48 percent used");
    expect(svg?.querySelector("text")?.textContent).toBe("48");
    expect(svg?.hasAttribute("data-warn")).toBe(false);
  });

  it("turns amber at 75 and clamps out-of-range values", () => {
    render(<Ring pct={75} />);
    expect(host.querySelector("svg")?.hasAttribute("data-warn")).toBe(true);
    render(<Ring pct={140} />);
    expect(host.querySelector("text")?.textContent).toBe("100");
  });
});

describe("Seg", () => {
  it("marks the selected option and reports a change", () => {
    const onChange = vi.fn();
    const options = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] as const;
    render(<Seg label="Mode" options={options} value="a" onChange={onChange} />);
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Mode");
    const [a, b] = [...host.querySelectorAll("button")];
    expect(a.getAttribute("aria-pressed")).toBe("true");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    act(() => b.click());
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Section and Kbd", () => {
  it("labels the section by its heading and renders actions", () => {
    render(<Section title="Seats" sub="3 live" actions={<button type="button">Add</button>}><p>body</p></Section>);
    const section = host.querySelector("section");
    const h2 = host.querySelector("h2");
    expect(section?.getAttribute("aria-labelledby")).toBe(h2?.id);
    expect(h2?.textContent).toBe("Seats");
    expect(host.textContent).toContain("3 live");
    expect(host.querySelector("header button")?.textContent).toBe("Add");
  });

  it("renders a kbd hint", () => {
    render(<Kbd>⌘K</Kbd>);
    expect(host.querySelector("kbd")?.textContent).toBe("⌘K");
  });
});
