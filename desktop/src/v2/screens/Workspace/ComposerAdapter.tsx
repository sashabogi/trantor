// Composer2 standing in for the classic composer inside the classic Chat, through Chat's own
// `deps.Composer` seam. It sends over the identical path: invoke("pane_send") with herdr's verdict (#13987).
import { useEffect, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Composer } from "../../../features/chat/Composer";
import { modelLabel } from "../../../features/chat/modelLabel";
import { brandOfModel, modelLabel as vendorModelLabel } from "../../ui/identity";
import { normalizeAttachments, type PromptVerdict } from "../../../features/chat/streaming";
import { parseAutonomy } from "./useWorkspaceData";
import { useAttachments } from "../../ui/useAttachments";
import { Composer2, type Choice } from "../../ui/Composer2";
import { useAgentMode } from "./useAgentMode";
import { featureRange, useAgentCliCompatibility } from "../../shell/agentCli";

type ClassicProps = ComponentProps<typeof Composer>;

// #13984 drill: the same options the classic composer offers, now listed with what each does.
export const MODEL_CHOICES: readonly Choice[] = [
  { value: "default", label: "Default", description: "Claude Code's own default for this account" },
  { value: "opus", label: "Opus", description: "Complex work and everyday tasks" },
  { value: "fable", label: "Fable", description: "The toughest problems" },
  { value: "sonnet", label: "Sonnet", description: "Most efficient for simpler tasks" },
];
export const EFFORT_CHOICES: readonly Choice[] = [
  { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" }, { value: "max", label: "Max" },
];
// #14022 trace: harness = the --dangerously-skip-permissions flag on the NEXT orchestrator launch or
// resume (bin/crew/open.mjs), baton = who fires the handoff at the context warn line. Neither touches a running session.
export const PERMISSION_CHOICES: readonly Choice[] = [
  { value: "ask", label: "Ask me", icon: "lock", description: "The next session starts with permission prompts, and a handoff asks you first." },
  { value: "auto", label: "Full auto", icon: "zap", tone: "warn", description: "The next session starts skipping permission prompts, and hands off on its own." },
];
export const PERMISSION_HEADING = "For new sessions and handoffs";

/** A readable model name for whichever vendor is orchestrating (#14018); Claude keeps the classic label. */
export function shownModel(model: string | undefined): string {
  if (!model) return "model unknown";
  return brandOfModel(model) === "claude" ? modelLabel(model).full.replace(/ \(.*\)$/, "") : vendorModelLabel(model);
}

/** Model, effort and the launch pair are Claude Code's commands; another harness gets none until its own are verified (#14018). */
export function isClaudeHosted(model: string | undefined): boolean {
  return !model || brandOfModel(model) === "claude";
}

/** The picker value the running model corresponds to; "default" is never claimed, since the id cannot say. */
export function modelChoiceOf(model: string): string | null {
  const m = model.toLowerCase();
  return MODEL_CHOICES.find(c => c.value !== "default" && m.includes(c.value))?.value ?? null;
}

type SendResult = { clear: boolean; note: string | null };

/** The classic delivery rules: delivered clears quietly, a pickup timeout clears with a note, anything else keeps the words. */
export function judge(d: PromptVerdict, blocked: string | null): SendResult {
  if (d.outcome === "delivered") return { clear: true, note: null };
  if (d.outcome === "sent") return { clear: true, note: "Sent, not yet picked up by the agent." };
  if (blocked && d.outcome === "blocked") return { clear: false, note: `The agent is asking a question above. Answer it there: "${blocked}"` };
  return { clear: false, note: `Not delivered: ${d.error ?? d.outcome}` };
}

function useHarness(project: string) {
  const [auto, setAuto] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setAuto(null);
    invoke<string>("autonomy_get", { project })
      .then(raw => { if (alive) setAuto(parseAutonomy(raw)?.harness === "bypass"); })
      .catch(() => {});
    return () => { alive = false; };
  }, [project]);
  const set = (next: boolean) => {
    setError(null);
    invoke<string>("autonomy_set", { project, dial: "harness", value: next ? "bypass" : "prompt" })
      .then(() => invoke<string>("autonomy_set", { project, dial: "baton", value: next ? "auto" : "ask" }))
      .then(() => setAuto(next))
      .catch(e => setError(`Permission not changed: ${String(e)}`));
  };
  return { auto, set, error };
}

export function ComposerAdapter(p: ClassicProps) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const harness = useHarness(p.project);
  // #14030: the Mode menu consults the table — below the feature's verified range it shows its
  // honest unavailable row; above it the closed-loop read stays the guard.
  const mode = useAgentMode(p.target, p.working, featureRange(useAgentCliCompatibility(), "Mode menu"));
  const attachments = useAttachments();
  const blockedQuestion = p.blockedAsk?.questions[0]?.question ?? null;
  const disabledReason = !p.live ? p.liveWhy : !p.target ? "There is no pane to send to" : null;
  const line = (text: string) => invoke<PromptVerdict>("pane_send", { target: p.target, text })
    .then(d => d ?? { outcome: "stalled", error: "the desktop did not answer" },
      e => ({ outcome: "stalled", error: String(e) }));
  const send = (raw: string) => {
    // #13984 drill: chips serialize at send and clear with the words, the classic order (serializeForSend, then normalize).
    const text = normalizeAttachments(attachments.serialize(raw).trim());
    void line(text).then(d => {
      const r = judge(d, blockedQuestion);
      setNote(r.note);
      if (r.clear) { setValue(""); attachments.clear(); }
      p.onSent();
      mode.read();
    });
  };
  // #13987 drill: Chat's suggestion pills did nothing in 2.0. A suggested reply IS a send, as in the classic composer.
  useEffect(() => {
    if (!p.suggestion || disabledReason) return;
    void line(p.suggestion).then(d => { setNote(judge(d, blockedQuestion).note); p.onSent(); });
    p.onSuggestionHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.suggestion]);
  // The pills hide while there are words in the box: report the draft, as the classic composer does.
  useEffect(() => { p.onDraftChange?.(value); }, [value]);  // eslint-disable-line react-hooks/exhaustive-deps
  const pickEffort = (v: string) => { setEffort(v); void line(`/effort ${v}`); p.onDispatch("effort", v); };
  // The pick is per project and saved before the slash command, exactly as the classic composer does it.
  const pickModel = (v: string) => {
    void invoke("project_model_pick", { project: p.project, model: v })
      .catch(e => setNote(`Model not saved for this project: ${String(e)}`))
      .then(() => line(`/model ${v}`));
    p.onDispatch("model", v);
  };
  const claude = isClaudeHosted(p.model);
  const frac = p.context.frac;
  const shown = note ?? mode.error ?? mode.unverifiedNote ?? harness.error;
  const modeProps = mode.supported ? {
    mode: mode.mode, modeChoices: mode.choices, onModeChange: mode.set,
    modeReading: mode.reading, onModeMenuOpen: mode.read,
  } : {};
  return (
    <div className="flex flex-col gap-1.5 border-t border-[var(--v2-edge)] px-3 pb-3 pt-2.5">
      {shown && <div role="status" className="text-v2-body text-[var(--v2-warn)]">{shown}</div>}
      <Composer2 value={value} onChange={v => { setValue(v); if (note) setNote(null); mode.clearError(); }} onSend={send} {...modeProps}
        permissionHeading={PERMISSION_HEADING}
        label="Message the orchestrator" placeholder="Message the orchestrator (⇧⏎ new line)"
        agent="orchestrator" model={{ id: p.model || "unknown", label: shownModel(p.model) }}
        modelChoices={claude ? MODEL_CHOICES : undefined} modelValue={modelChoiceOf(p.model || "")} onModelChange={pickModel}
        effort={claude ? effort : undefined} effortChoices={EFFORT_CHOICES} onEffortChange={pickEffort}
        permission={harness.auto ? "auto" : "ask"} permissionChoices={PERMISSION_CHOICES} onPermissionChange={next => harness.set(next === "auto")}
        contextPct={frac == null ? null : Math.round(frac * 100)} attachments={attachments} disabledReason={disabledReason} />
    </div>
  );
}
