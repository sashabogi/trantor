// Composer2 standing in for the classic composer inside the classic Chat, through Chat's own
// `deps.Composer` seam. It sends over the identical path: invoke("pane_send") with herdr's verdict (#13987).
// #14488: words and chips live in the classic composerDraft slots — one per project, debounced to
// composer_draft_set — so a draft survives a restart and never rides into another project.
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Composer } from "../../../features/chat/Composer";
import { modelLabel } from "../../../features/chat/modelLabel";
import { brandOfModel, modelLabel as vendorModelLabel } from "../../ui/identity";
import { canSendDraft, composerDraftApi, draftSlots, emptyDraft, flushSaves, isEmptyDraft, scheduleSave, type ComposerDraft } from "../../../features/chat/composerDraft";
import { normalizeAttachments, composerSlot, type PromptVerdict } from "../../../features/chat/streaming";
import { parseAutonomy } from "./useWorkspaceData";
import { useAttachments } from "../../ui/useAttachments";
import { Composer2, type Choice } from "../../ui/Composer2";
import { useAgentMode } from "./useAgentMode";
import { featureRange, useAgentCliCompatibility } from "../../shell/agentCli";

import { searchFiles } from "../../../features/code/fileApi";

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
  const [state, setState] = useState<{ project: string; auto: boolean } | null>(null);
  const generation = useRef(0);
  const read = (raw: string) => {
    const resolved = parseAutonomy(raw);
    return resolved?.harness === "bypass" && resolved.baton === "auto";
  };
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const version = ++generation.current;
    setState(null);
    setError(null);
    invoke<string>("autonomy_get", { project })
      .then(raw => { if (alive && version === generation.current) setState({ project, auto: read(raw) }); })
      .catch(() => {});
    return () => { alive = false; generation.current++; };
  }, [project]);
  const set = (next: boolean) => {
    const version = ++generation.current;
    setError(null);
    invoke<string>("autonomy_set", { project, dial: "harness", value: next ? "bypass" : "prompt" })
      .then(() => invoke<string>("autonomy_set", { project, dial: "baton", value: next ? "auto" : "ask" }))
      .then(raw => { if (version === generation.current) setState({ project, auto: read(raw) }); })
      .catch(e => {
        if (version !== generation.current) return;
        setState(null);
        setError(`Permission not changed: ${String(e)}`);
      });
  };
  return { auto: state?.project === project && state.auto, set, error };
}

export function ComposerAdapter(p: ClassicProps) {
  // #14488: the draft is words + chips + the project they were written for (#11665), in one slot
  // per project — the adapter is mounted once for whichever project is selected, so when the
  // `project` prop moves the draft is swapped here rather than carried into the new one.
  const [current, setCurrent] = useState<ComposerDraft>(() => draftSlots.get(p.project) ?? emptyDraft(p.project));
  if (current.project !== p.project) setCurrent(draftSlots.get(p.project) ?? emptyDraft(p.project));
  const value = current.text;
  const [note, setNote] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const harness = useHarness(p.project);
  useEffect(() => {
    p.onLongRunChange(harness.auto);
  }, [harness.auto, p.onLongRunChange]);
  // #14030: the Mode menu consults the table — below the feature's verified range it shows its
  // honest unavailable row; above it the closed-loop read stays the guard.
  const mode = useAgentMode(p.target, p.working, featureRange(useAgentCliCompatibility(), "Mode menu"));
  const attachments = useAttachments();
  const fileSearch = useCallback((query: string) => searchFiles(p.project, query), [p.project]);
  const blockedQuestion = p.blockedAsk?.questions[0]?.question ?? null;
  const disabledReason = !p.live ? p.liveWhy : !p.target ? "There is no pane to send to" : null;
  // Chips are born in the attachments hook (drop, paste, pick); the draft mirrors them so the slot
  // and the disk copy carry the whole draft. The ref skips the mount pass: a slot-restored draft's
  // chips must not be wiped by the hook's initial empty row.
  const seenChips = useRef(attachments.chips);
  useEffect(() => {
    if (seenChips.current === attachments.chips) return;
    seenChips.current = attachments.chips;
    setCurrent(c => ({ ...c, chips: attachments.chips }));
  }, [attachments.chips]);
  // Every edit lands in the project's slot and, debounced, on disk. An untouched empty draft is
  // not written: it would clobber the persisted one before the restore below has read it.
  useEffect(() => {
    if (isEmptyDraft(current) && !draftSlots.get(current.project)) return;
    draftSlots.put(current);
    scheduleSave(current);
  }, [current]);
  useEffect(() => () => flushSaves(), []);
  // A project switch swaps the whole draft (#11665): the outgoing words and chips stay in their
  // own slot (the mirror effect above put them there), the incoming project brings only its own.
  useEffect(() => {
    attachments.restore(draftSlots.get(p.project)?.chips ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.project]);
  // After a restart the slot is empty but the disk may hold this project's draft: read it once the
  // project is shown, unless the operator already typed (a slot exists by then).
  useEffect(() => {
    if (draftSlots.get(p.project)) return;
    let alive = true;
    void composerDraftApi.get(p.project).then(saved => {
      if (!alive || !saved || draftSlots.get(p.project)) return;
      draftSlots.put(saved);
      setCurrent(c => (c.project === p.project && isEmptyDraft(c) ? saved : c));
      attachments.restore(saved.chips);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.project]);
  const line = (text: string) => invoke<PromptVerdict>("pane_send", { target: p.target, text })
    .then(d => d ?? { outcome: "stalled", error: "the desktop did not answer" },
      e => ({ outcome: "stalled", error: String(e) }));
  const send = (raw: string) => {
    // #14488: the draft goes only to the project it was written for, refused here the classic way.
    if (!canSendDraft(current, p.project)) { setNote("This draft belongs to another project — not sent"); return; }
    // #13984 drill: chips serialize at send and clear with the words, the classic order (serializeForSend, then normalize).
    const text = normalizeAttachments(attachments.serialize(raw).trim());
    void line(text).then(d => {
      const r = judge(d, blockedQuestion);
      setNote(r.note);
      if (r.clear) { setCurrent(c => emptyDraft(c.project)); attachments.clear(); }
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
  // #14487: interrupting is a KEY, not a message — the classic stop, over the same pane_keys
  // command. The slot rule stays the classic composerSlot, never forked: a running turn with an
  // empty box stops, while words or chips queue a message instead (Claude Code queues mid-turn).
  const stop = () => {
    if (!p.target) return;
    invoke("pane_keys", { target: p.target, keys: "Escape" })
      .catch(e => setNote(`Not interrupted: ${String(e)}`));
  };
  const stoppable = composerSlot(p.working, p.live, value, false, attachments.chips.length).kind === "stop" && !!p.target;
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
    <div className="v2-composer-gutter">
      <div className="v2-composer-float flex flex-col gap-1.5">
        {shown && <div role="status" className="text-v2-body text-[var(--v2-warn)]">{shown}</div>}
        <Composer2 fileSearch={fileSearch} onPickFile={attachments.addPath} busy={p.working} value={value} onChange={v => { setCurrent(c => ({ ...c, text: v })); if (note) setNote(null); mode.clearError(); }} onSend={send} {...modeProps}
          permissionHeading={PERMISSION_HEADING}
          label="Message the orchestrator" placeholder="Message the orchestrator (⇧⏎ new line)"
          agent="orchestrator" model={{ id: p.model || "unknown", label: shownModel(p.model) }}
          modelChoices={claude ? MODEL_CHOICES : undefined} modelValue={modelChoiceOf(p.model || "")} onModelChange={pickModel}
          effort={claude ? effort : undefined} effortChoices={EFFORT_CHOICES} onEffortChange={pickEffort}
          permission={harness.auto ? "auto" : "ask"} permissionChoices={PERMISSION_CHOICES} onPermissionChange={next => harness.set(next === "auto")}
          contextPct={frac == null ? null : Math.round(frac * 100)} attachments={attachments} disabledReason={disabledReason}
          onStop={stoppable ? stop : undefined} />
      </div>
    </div>
  );
}
