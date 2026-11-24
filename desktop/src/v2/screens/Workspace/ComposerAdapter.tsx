// Composer2 standing in for the classic composer inside the classic Chat, through Chat's own
// `deps.Composer` seam. It sends over the identical path: invoke("pane_send") with herdr's verdict (#13987).
import { useEffect, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Composer } from "../../../features/chat/Composer";
import { modelLabel } from "../../../features/chat/modelLabel";
import { normalizeAttachments, type PromptVerdict } from "../../../features/chat/streaming";
import { parseAutonomy } from "./useWorkspaceData";
import { useAttachments } from "../../ui/useAttachments";
import { Composer2, EFFORT_LABELS, type Effort, type Permission } from "../../ui/Composer2";

type ClassicProps = ComponentProps<typeof Composer>;

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
  const [effort, setEffort] = useState<Effort>(2);
  const harness = useHarness(p.project);
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
    });
  };
  const pickEffort = (e: Effort) => { setEffort(e); void line(`/effort ${EFFORT_LABELS[e]}`); p.onDispatch("effort", EFFORT_LABELS[e]); };
  const permission: Permission = harness.auto ? "auto" : "ask";
  const frac = p.context.frac;
  const shown = note ?? harness.error;
  return (
    <div className="flex flex-col gap-1.5 border-t border-[var(--v2-edge)] px-3 pb-3 pt-2.5">
      {shown && <div role="status" className="text-[11.5px] text-[var(--v2-warn)]">{shown}</div>}
      <Composer2 value={value} onChange={v => { setValue(v); if (note) setNote(null); }} onSend={send}
        label="Message the orchestrator" placeholder="Message the orchestrator (⇧⏎ new line)"
        agent="orchestrator" model={{ id: p.model || "unknown", label: p.model ? modelLabel(p.model).full.replace(/ \(.*\)$/, "") : "model unknown" }}
        effort={effort} onEffortChange={pickEffort}
        permission={permission} onPermissionChange={next => harness.set(next !== "ask")}
        contextPct={frac == null ? null : Math.round(frac * 100)} attachments={attachments} disabledReason={disabledReason} />
    </div>
  );
}
