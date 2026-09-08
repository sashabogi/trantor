// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describeFocus, findLensButton, parseKeyDrillPayload, runKeyDrill, type KeyDrillDeps } from "./keyDrill";

type Call = { cmd: string; args: InvokeArgs | undefined };

function makeDeps(calls: Call[], failing?: string): KeyDrillDeps {
  let clock = 1_000;
  return {
    invoke: <T,>(cmd: string, args?: InvokeArgs) => {
      calls.push({ cmd, args });
      if (cmd === failing) return Promise.reject(new Error("TRANTOR_KEY_DRILL is not set"));
      // SAFETY: the drill never reads a command's return value, so undefined stands in for every T.
      return Promise.resolve(undefined as T);
    },
    document,
    now: () => clock,
    sleep: ms => {
      clock += ms;
      return Promise.resolve();
    },
    armDeadline: () => () => {},
  };
}

function logLines(calls: Call[]): string[] {
  const lines: string[] = [];
  for (const { cmd, args } of calls) {
    if (cmd === "app_log" && args && "line" in args) lines.push(String(args.line));
  }
  return lines;
}

function posts(calls: Call[]): (InvokeArgs | undefined)[] {
  return calls.filter(c => c.cmd === "key_drill_post").map(c => c.args);
}

/** A sidebar row for the project; clicking it opens the mode pane and the lens segment. Clicking
 *  the Workspace lens mounts the terminal pane, the way Workspace selects its first target. */
function mountSidebar(project: string): void {
  document.body.innerHTML = `
    <div role="button"><span class="block truncate">${project}</span></div>
    <div id="pane"></div>
  `;
  document.querySelector<HTMLElement>('div[role="button"]')!.addEventListener("click", () => {
    document.getElementById("pane")!.innerHTML = `
      <div class="tr-seg">
        <button data-on="false">Workspace</button>
        <button data-on="true">Board</button>
      </div>
      <button aria-label="Chat" data-on="false">Chat</button>
    `;
    findLensButton(document, "Workspace")!.addEventListener("click", () => {
      document.getElementById("pane")!.insertAdjacentHTML(
        "beforeend",
        `<textarea class="xterm-helper-textarea"></textarea><textarea id="composer"></textarea>`,
      );
    });
  });
}

describe("right-arrow key drill (#6317)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reads the mode and project off the JSON payload, and the bare mode string too", () => {
    expect(parseKeyDrillPayload('{"mode":"throw","project":"drill-key"}')).toEqual({ mode: "throw", project: "drill-key" });
    expect(parseKeyDrillPayload('{"mode":"post","project":null}')).toEqual({ mode: "post", project: null });
    expect(parseKeyDrillPayload('{"mode":"post","project":"  "}')).toEqual({ mode: "post", project: null });
    expect(parseKeyDrillPayload("throw")).toEqual({ mode: "throw", project: null });
    expect(parseKeyDrillPayload("post")).toEqual({ mode: "post", project: null });
    expect(parseKeyDrillPayload("")).toEqual({ mode: "post", project: null });
  });

  it("describes what holds focus and whether it is editable", () => {
    document.body.innerHTML = `<textarea class="xterm-helper-textarea  extra"></textarea><div id="d"></div>`;
    expect(describeFocus(document)).toEqual({ target: "body", editable: false });
    document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
    expect(describeFocus(document)).toEqual({ target: "textarea.xterm-helper-textarea", editable: true });
  });

  it("posts the key at body, the terminal pane and another textarea, then finishes", async () => {
    document.body.innerHTML = `
      <textarea class="xterm-helper-textarea"></textarea>
      <textarea id="composer"></textarea>
    `;
    const calls: Call[] = [];
    await runKeyDrill({ mode: "throw", project: null }, makeDeps(calls));

    expect(posts(calls)).toEqual([
      { pass: 1, target: "body", editable: false },
      { pass: 2, target: "textarea.xterm-helper-textarea", editable: true },
      { pass: 3, target: "textarea", editable: true },
    ]);
    const finish = calls.filter(c => c.cmd === "key_drill_finish");
    expect(finish).toHaveLength(1);
    expect(finish[0].args).toEqual({
      summary: "mode=throw 1:body 2:textarea.xterm-helper-textarea 3:textarea",
    });
    expect(calls.findIndex(c => c.cmd === "key_drill_finish")).toBeGreaterThan(
      calls.map(c => c.cmd).lastIndexOf("key_drill_post"),
    );
  });

  it("stages the project first: sidebar row, then the Workspace lens, so the terminal pane is there for pass 2", async () => {
    mountSidebar("drill-key");
    const calls: Call[] = [];
    await runKeyDrill({ mode: "post", project: "drill-key" }, makeDeps(calls));

    expect(posts(calls)).toEqual([
      { pass: 1, target: "body", editable: false },
      { pass: 2, target: "textarea.xterm-helper-textarea", editable: true },
      { pass: 3, target: "textarea", editable: true },
    ]);
    const logs = logLines(calls);
    expect(logs[0]).toBe("key-drill start mode=post project=drill-key");
    expect(logs).toContain("key-drill staged project=drill-key lens=workspace");
    expect(findLensButton(document, "Workspace")).not.toBeNull();
  });

  it("reports a staging failure and still runs the passes when the project has no sidebar row", async () => {
    document.body.innerHTML = `<div role="button"><span class="block truncate">other</span></div>`;
    const calls: Call[] = [];
    await runKeyDrill({ mode: "post", project: "drill-key" }, makeDeps(calls));

    const logs = logLines(calls);
    expect(logs.some(l => l.startsWith("key-drill staging failed: no sidebar row for project=drill-key"))).toBe(true);
    expect(posts(calls)).toEqual([{ pass: 1, target: "body", editable: false }]);
    expect(calls.filter(c => c.cmd === "key_drill_finish")[0].args).toEqual({
      summary: "mode=post 1:body 2:skipped 3:skipped",
    });
  });

  it("skips the passes whose target never mounts and still finishes", async () => {
    const calls: Call[] = [];
    await runKeyDrill({ mode: "post", project: null }, makeDeps(calls));

    expect(posts(calls)).toEqual([{ pass: 1, target: "body", editable: false }]);
    expect(calls.filter(c => c.cmd === "key_drill_finish")[0].args).toEqual({
      summary: "mode=post 1:body 2:skipped 3:skipped",
    });
    const logs = logLines(calls);
    expect(logs).toContain("key-drill pass=2 skipped: no terminal pane mounted");
    expect(logs).toContain("key-drill pass=3 skipped: no other textarea");
  });

  it("logs instead of throwing when Rust refuses the post", async () => {
    const calls: Call[] = [];
    await runKeyDrill({ mode: "post", project: null }, makeDeps(calls, "key_drill_post"));
    expect(calls.filter(c => c.cmd === "key_drill_finish")).toHaveLength(0);
    expect(logLines(calls).some(l => l.startsWith("key-drill ERROR"))).toBe(true);
  });
});
