// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describeFocus, runKeyDrill, type KeyDrillDeps } from "./keyDrill";

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
  };
}

function logLines(calls: Call[]): string[] {
  const lines: string[] = [];
  for (const { cmd, args } of calls) {
    if (cmd === "app_log" && args && "line" in args) lines.push(String(args.line));
  }
  return lines;
}

describe("right-arrow key drill (#6317)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
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
    await runKeyDrill("throw", makeDeps(calls));

    const posts = calls.filter(c => c.cmd === "key_drill_post").map(c => c.args);
    expect(posts).toEqual([
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

  it("skips the passes whose target never mounts and still finishes", async () => {
    const calls: Call[] = [];
    await runKeyDrill("post", makeDeps(calls));

    const posts = calls.filter(c => c.cmd === "key_drill_post").map(c => c.args);
    expect(posts).toEqual([{ pass: 1, target: "body", editable: false }]);
    expect(calls.filter(c => c.cmd === "key_drill_finish")[0].args).toEqual({
      summary: "mode=post 1:body 2:skipped 3:skipped",
    });
    const logs = logLines(calls);
    expect(logs).toContain("key-drill pass=2 skipped: no terminal pane mounted");
    expect(logs).toContain("key-drill pass=3 skipped: no other textarea");
  });

  it("logs instead of throwing when Rust refuses the post", async () => {
    const calls: Call[] = [];
    await runKeyDrill("post", makeDeps(calls, "key_drill_post"));
    expect(calls.filter(c => c.cmd === "key_drill_finish")).toHaveLength(0);
    expect(logLines(calls).some(l => l.startsWith("key-drill ERROR"))).toBe(true);
  });
});
