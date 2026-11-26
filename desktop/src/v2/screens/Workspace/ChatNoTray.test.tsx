// @vitest-environment happy-dom
// #13987 drill: opening Chat's terminal tray blanked the Workspace terminal, so 2.0 keeps it folded.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { loadTrayOpen, saveTrayOpen } from "../../../features/chat/prefs";
import { ChatNoTray } from "./RightPanel";

describe("ChatNoTray", () => {
  it("folds a tray left open before the chat mounts", () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    saveTrayOpen(true);
    const host = document.createElement("div");
    act(() => { createRoot(host).render(<ChatNoTray onOpenChange={() => {}}><p>chat</p></ChatNoTray>); });
    expect(loadTrayOpen()).toBe(false);
    expect(host.querySelector("[data-v2-chat]")?.textContent).toBe("chat");
  });

  it("rides the chat's left edge once two prompts exist (#14327)", () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    act(() => {
      createRoot(host).render(<ChatNoTray onOpenChange={() => {}}>
        <div data-prompt-id="0">one</div><div data-prompt-id="2">two</div>
      </ChatNoTray>);
    });
    const row = host.firstElementChild;
    expect(row?.firstElementChild?.tagName).toBe("NAV");
    expect(row?.lastElementChild?.getAttribute("data-v2-chat")).not.toBeNull();
    expect(row?.firstElementChild?.className).toContain("left-[3px]");
  });
});
