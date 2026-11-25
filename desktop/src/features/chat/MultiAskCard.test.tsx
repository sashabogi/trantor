// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { MultiAskCard } from "./MultiAskCard";
import { choose, isComplete, startPicks, toAnswers, typeOther } from "./askPicks";
import type { AskQuestion } from "./streaming";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const opts = [{ label: "One", description: "" }, { label: "Two", description: "" }];
const questions: AskQuestion[] = [
  { header: "First", question: "Which one?", multiSelect: false, options: opts },
  { header: "Second", question: "Which many?", multiSelect: true, options: opts },
  { header: "Third", question: "Which last?", multiSelect: false, options: opts },
];

describe("ask picks", () => {
  it("keeps a pick per question and completes only when all are answered", () => {
    let s = startPicks(questions);
    s = choose(s, questions[0], 1);
    expect(isComplete(s)).toBe(false);
    s = { ...s, index: 1 };
    s = choose(choose(s, questions[1], 1), questions[1], 0);
    s = typeOther({ ...s, index: 2 }, questions[2], "Oslo");
    expect(isComplete(s)).toBe(true);
    expect(toAnswers(s)).toEqual([
      { picks: [1], other: null },
      { picks: [0, 1], other: null },
      { picks: [], other: "Oslo" },
    ]);
  });

  it("lets a single choice hold a pick or typed text, the latest winning", () => {
    let s = choose(startPicks(questions), questions[0], 0);
    s = typeOther(s, questions[0], "Later");
    expect(toAnswers(s)[0]).toEqual({ picks: [], other: "Later" });
    s = choose(s, questions[0], 1);
    expect(toAnswers(s)[0]).toEqual({ picks: [1], other: null });
  });
});

describe("MultiAskCard", () => {
  let root: Root | null = null;
  afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

  function mount() {
    const calls: Array<{ cmd: string; args?: InvokeArgs }> = [];
    const sent: string[] = [];
    const invokeFn = <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
      calls.push({ cmd, args });
      return Promise.resolve(JSON.parse('"KEYS"'));
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(
      <MultiAskCard toolId="t1" questions={questions} enabled waiting={false} invokeFn={invokeFn}
        onAnswer={async (_id, data) => { sent.push(data); }} />,
    ));
    return { host, calls, sent };
  }
  const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")];
  const byText = (host: HTMLElement, text: string) => {
    const b = buttons(host).find(x => x.textContent?.trim() === text);
    if (!b) throw new Error(`no button ${text}`);
    return b;
  };
  const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const counter = (host: HTMLElement) => host.querySelector("[data-testid=ask-counter]")?.textContent;

  it("moves with Next and Back, keeps picks, and submits all answers in order", async () => {
    const { host, calls, sent } = mount();
    expect(counter(host)).toBe("Question 1 of 3");
    expect(byText(host, "Back").disabled).toBe(true);
    expect(byText(host, "Submit").disabled).toBe(true);
    click(byText(host, "Two"));
    click(byText(host, "Next"));
    expect(counter(host)).toBe("Question 2 of 3");
    click(byText(host, "One"));
    click(byText(host, "Two"));
    click(byText(host, "Next"));
    expect(byText(host, "Next").disabled).toBe(true);
    expect(byText(host, "Submit").disabled).toBe(true);
    click(byText(host, "One"));
    expect(byText(host, "Submit").disabled).toBe(false);
    click(byText(host, "Back"));
    click(byText(host, "Back"));
    expect(counter(host)).toBe("Question 1 of 3");
    expect(byText(host, "Two").getAttribute("aria-pressed")).toBe("true");
    click(byText(host, "Submit"));
    await act(async () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("answer_all_keystrokes");
    expect(calls[0].args).toEqual({
      questions,
      answers: [
        { picks: [1], other: null },
        { picks: [0, 1], other: null },
        { picks: [0], other: null },
      ],
    });
    expect(sent).toEqual(["KEYS"]);
  });
});
