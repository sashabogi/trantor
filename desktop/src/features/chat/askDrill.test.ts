// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { runAskDrill, type AskDrillDeps } from "./askDrill";

type Active = {
  marker: string;
  sessionId: string;
  sidecar: boolean;
  answered: boolean;
  advanced: boolean;
  ts: number;
};

describe("real AskUserQuestion drill (#6533)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button aria-label="Files" data-on="true">Files</button>
      <button aria-label="Chat" data-on="false">Chat</button>
      <main id="mode"></main>
    `;
  });

  it("drives interactive sessions through the open and cold Chat paths", async () => {
    let clock = 10_000;
    let active: Active | null = null;
    let starts = 0;
    let closes = 0;
    const logs: string[] = [];
    const files = document.querySelector<HTMLButtonElement>('button[aria-label="Files"]')!;
    const chat = document.querySelector<HTMLButtonElement>('button[aria-label="Chat"]')!;
    const mode = document.querySelector<HTMLElement>("#mode")!;

    const removeCard = () => { mode.replaceChildren(); };
    const renderCard = () => {
      removeCard();
      if (!active?.sidecar || chat.dataset.on !== "true") return;
      const card = document.createElement("div");
      card.dataset.testid = "ask-card";
      card.textContent = `TRANTOR ASK DRILL ${active.marker}: continue?`;
      const answer = document.createElement("button");
      answer.textContent = "Continue";
      answer.onclick = () => {
        if (!active) return;
        active.sidecar = false;
        active.answered = true;
        active.advanced = true;
        removeCard();
      };
      card.append(answer);
      mode.append(card);
    };
    files.onclick = () => {
      files.dataset.on = "true";
      chat.dataset.on = "false";
      removeCard();
    };
    chat.onclick = () => {
      files.dataset.on = "false";
      chat.dataset.on = "true";
      renderCard();
    };

    const invoke = async <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
      // SAFETY: this fake receives only the object-shaped arguments runAskDrill sends.
      const fields = args as { line?: unknown; marker?: unknown } | undefined;
      if (cmd === "app_log") {
        logs.push(String(fields?.line ?? ""));
        // SAFETY: runAskDrill requests no value from app_log.
        return undefined as T;
      }
      if (cmd === "ask_drill_start") {
        const marker = String(fields?.marker);
        starts++;
        active = {
          marker,
          sessionId: `session-${starts}`,
          sidecar: true,
          answered: false,
          advanced: false,
          ts: clock,
        };
        renderCard();
        // SAFETY: ask_drill_start requests exactly this DrillSession shape.
        return { workspace: `w${starts}`, pane: `w${starts}:p1`, agent: `askdrill${starts}` } as T;
      }
      if (cmd === "ask_drill_probe") {
        // SAFETY: ask_drill_probe requests exactly this DrillProbe shape.
        return {
          sessionId: active?.sessionId ?? null,
          sidecarExists: active?.sidecar ?? false,
          sidecarTs: active?.ts ?? null,
          transcriptLines: active?.answered ? 3 : 1,
          traceSeen: Boolean(active),
          openEvents: active ? 1 : 0,
          webviewEventTs: active ? active.ts + 100 : null,
          cardMountTs: active ? active.ts + 200 : null,
          pickerVisible: active?.answered ?? false,
          toolResultMatches: active?.answered ?? false,
          paneAdvanced: active?.advanced ?? false,
        } as T;
      }
      if (cmd === "ask_drill_close") {
        closes++;
        active = null;
        removeCard();
        // SAFETY: runAskDrill requests no value from ask_drill_close.
        return undefined as T;
      }
      throw new Error(`unexpected command: ${cmd}`);
    };
    const deps: AskDrillDeps = {
      invoke,
      document,
      now: () => clock,
      sleep: async ms => { clock += ms; },
    };

    await runAskDrill(JSON.stringify({ project: "trantor" }), deps);

    expect(starts).toBe(2);
    expect(closes).toBe(2);
    expect(logs.some(line => line.includes("open PASS"))).toBe(true);
    expect(logs.some(line => line.includes("cold PASS"))).toBe(true);
    expect(logs[logs.length - 1]).toContain("real AskUserQuestion sidecar/card/answer path passed");
    expect(logs.some(line => line.includes("FAILED"))).toBe(false);
  });
});
