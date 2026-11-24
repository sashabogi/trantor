// @vitest-environment happy-dom
// #v2-F: the composer is controlled, sends on Enter, and every control says what it is.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer2, type Composer2Props, type Effort, type Permission } from "./Composer2";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function Harness({ onSend, extra }: { onSend: (t: string) => void; extra?: Partial<Composer2Props> }) {
  const [value, setValue] = useState("");
  const [effort, setEffort] = useState<Effort>(2);
  const [permission, setPermission] = useState<Permission>("guarded");
  return (
    <Composer2 value={value} onChange={setValue} onSend={t => { onSend(t); setValue(""); }}
      label="Message the orchestrator" agent="orchestrator" model={{ id: "claude-opus-5-5", label: "opus 5.5" }}
      effort={effort} onEffortChange={setEffort} permission={permission} onPermissionChange={setPermission}
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

  it("puts the paperclip right before the round send button", () => {
    act(() => root.render(<Harness onSend={vi.fn()} />));
    const send = q('button[aria-label="Send"]');
    expect(send?.previousElementSibling?.getAttribute("aria-label")).toBe("Attach a file or image");
    expect(send?.className).toContain("rounded-full");
  });

  it("cycles effort and permission, and shows the context ring with its percent", () => {
    act(() => root.render(<Harness onSend={vi.fn()} />));
    expect(q('[aria-label="Effort: high"]')?.querySelectorAll("[data-lit]").length).toBe(3);
    act(() => q('[aria-label="Effort: high"]')?.click());
    expect(q('[aria-label="Effort: max"]')).not.toBeNull();
    act(() => q('[aria-label="Effort: max"]')?.click());
    expect(q('[aria-label="Effort: low"]')).not.toBeNull();
    act(() => q('[aria-label="Permission: asks before irreversible actions"]')?.click());
    expect(q('[aria-label="Permission: full auto"]')?.title).toContain("Runs without asking");
    expect(q('svg[role="img"] text')?.textContent).toBe("48");
  });

  it("hides controls a harness does not support", () => {
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ showEffort: false, showPermission: false }} />));
    expect(q('[aria-label^="Effort:"]')).toBeNull();
    expect(q('[aria-label^="Permission:"]')).toBeNull();
    expect(q('[data-group="model"]')?.textContent).toBe("opus 5.5");
  });

  it("renders read-only labels without handlers, hides the ring without data, and explains a blocked send", () => {
    act(() => root.render(<Harness onSend={vi.fn()} extra={{ onEffortChange: undefined, contextPct: null, onAttach: undefined, disabledReason: "Seat is offline" }} />));
    expect(q('[aria-label="Effort: high"]')?.tagName).toBe("SPAN");
    expect(q('svg[aria-label^="Context"]')).toBeNull();
    expect(q('button[aria-label="Attach a file or image"]')?.hasAttribute("disabled")).toBe(true);
    type("hello");
    const send = q('button[aria-label="Send"]');
    expect(send?.hasAttribute("disabled")).toBe(true);
    expect(send?.title).toBe("Seat is offline");
  });
});
