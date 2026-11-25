// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { keepInputsPlain } from "./plainInputs";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("keepInputsPlain", () => {
  it("opts out inputs that exist and inputs that mount later, and leaves textareas alone", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<input id="a"><textarea id="t"></textarea><input id="kept" spellcheck="true">';
    document.body.append(root);
    const stop = keepInputsPlain(root);
    expect(root.querySelector("#a")?.getAttribute("autocapitalize")).toBe("off");
    expect(root.querySelector("#a")?.getAttribute("autocorrect")).toBe("off");
    expect(root.querySelector("#a")?.getAttribute("spellcheck")).toBe("false");
    expect(root.querySelector("#t")?.hasAttribute("autocorrect")).toBe(false);
    expect(root.querySelector("#kept")?.getAttribute("spellcheck")).toBe("true");
    const wrap = document.createElement("section");
    wrap.innerHTML = '<input id="late">';
    root.append(wrap);
    await settle();
    expect(root.querySelector("#late")?.getAttribute("autocapitalize")).toBe("off");
    stop();
    const after = document.createElement("input");
    root.append(after);
    await settle();
    expect(after.hasAttribute("autocapitalize")).toBe(false);
    root.remove();
  });
});
