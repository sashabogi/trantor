// Drill Mode (#6800): a guided pass over the visual testing backlog, run on a disposable
// drill-* project seeded at start, never a real one. Pass captures a screenshot and closes
// the card; Fail bounces it to doing. A DOM auto-check can pre-fill the verdict, but per
// the stabilize doctrine the operator's press is what actually moves the card.
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { CheckCircle2, ChevronRight, ClipboardCheck, Play, X, XCircle } from "lucide-react";
import { WizardFrame } from "../onboarding/WizardFrame";
import { drillApi, type DrillApi } from "./drillApi";
import {
  DRILL_STEPS,
  DRIVE_LABELS,
  isDisposableProject,
  noteFor,
  statusFor,
  summarize,
  type AutoCheckResult,
  type StepOutcome,
  type Verdict,
} from "./drillSteps";

type Phase =
  | { kind: "seeding" }
  | { kind: "refused"; why: string }
  | { kind: "running"; project: string }
  | { kind: "finished"; project: string };

export function DrillMode({ me, onClose, deps = drillApi }: {
  me: string;
  onClose: () => void;
  deps?: DrillApi;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "seeding" });
  const [index, setIndex] = useState(0);
  const [outcomes, setOutcomes] = useState<StepOutcome[]>([]);
  const [auto, setAuto] = useState<AutoCheckResult | null>(null);
  const [operatorNote, setOperatorNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [driving, setDriving] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    deps.trace("start");
    void deps.seedProject()
      .then(project => {
        if (!alive) return;
        if (!isDisposableProject(project)) {
          deps.trace(`refused: stage '${project}' is not disposable`);
          setPhase({ kind: "refused", why: `${project} is a real project, not a drill-* stage. Drill Mode refuses to run on it.` });
          return;
        }
        deps.trace(`stage ${project}`);
        setPhase({ kind: "running", project });
      })
      .catch(e => {
        if (!alive) return;
        const message = e instanceof Error ? e.message : String(e);
        deps.trace(`seed failed: ${message}`);
        setPhase({ kind: "refused", why: `Could not seed a disposable project: ${message}` });
      });
    return () => { alive = false; };
    // deps identity is stable for the panel's lifetime; re-running would re-seed mid-drill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = DRILL_STEPS[index];
  const total = DRILL_STEPS.length;
  const last = index === total - 1;

  // A fresh step gets a fresh auto-check and a clean note; the probe is cheap and re-runnable.
  useEffect(() => {
    if (phase.kind !== "running") return;
    setOperatorNote("");
    setError(null);
    setAuto(step.autoCheck ? deps.autoCheck(step.autoCheck) : null);
    // step/phase are what change here; deps is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, phase.kind]);

  const recheck = () => { if (step.autoCheck) setAuto(deps.autoCheck(step.autoCheck)); };

  // The driver's result pre-fills the verdict exactly like a probe; it never moves the card.
  const drive = async () => {
    if (phase.kind !== "running" || !step.drive || busy || driving) return;
    setDriving(true);
    setError(null);
    try {
      setAuto(await deps.drive(step.drive, phase.project));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deps.trace(`#${step.card} drive failed: ${message}`);
      setError(`Drive failed — ${message}`);
    } finally {
      setDriving(false);
    }
  };

  // Leaving a driven step tears down what the driver left behind (the ask's herdr workspace).
  const leave = (project: string) => {
    if (step.drive) void deps.endDrive(step.drive, project).catch(() => {});
  };

  const advance = (project: string) => {
    leave(project);
    if (last) { setPhase({ kind: "finished", project }); return; }
    setIndex(i => i + 1);
  };

  const decide = async (verdict: Verdict) => {
    if (phase.kind !== "running" || busy) return;
    const { project } = phase;
    setBusy(true);
    setError(null);
    let screenshot: string | null = null;
    try {
      if (verdict === "pass") {
        // Paint the hidden panel BEFORE the capture waits, so the evidence never shows the checklist.
        flushSync(() => setCapturing(true));
        await deps.settle();
        try {
          screenshot = await deps.screenshot(`card-${step.card}`);
        } finally {
          setCapturing(false);
        }
      }
      const note = noteFor({ verdict, me, project, screenshot, autoCheck: auto, operatorNote });
      await deps.moveCard(step.card, statusFor(verdict), note);
      deps.trace(`#${step.card} ${verdict}${screenshot ? ` ${screenshot}` : ""}`);
      setOutcomes(prev => [...prev, { card: step.card, verdict, screenshot }]);
      advance(project);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deps.trace(`#${step.card} ${verdict} not recorded: ${message}`);
      setError(`Not recorded — ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const skip = () => {
    if (phase.kind !== "running" || busy) return;
    deps.trace(`#${step.card} skipped`);
    advance(phase.project);
  };

  const close = () => {
    if (phase.kind === "running") leave(phase.project);
    deps.trace(`closed ${summarize(outcomes, total)}`);
    onClose();
  };

  const stopButton = (
    <button type="button" onClick={close} disabled={busy} title="Stop the drill"
      className="tr-input mr-auto flex items-center gap-1 disabled:opacity-40">
      <X size={13} /> Stop
    </button>
  );

  if (phase.kind === "seeding") {
    return (
      <WizardFrame icon={<ClipboardCheck size={17} />} title="Drill Mode" sub="Seeding a disposable project" index={0} total={total} layout="dock" footer={stopButton}>
        <div className="text-[12.5px] text-[var(--color-tr-muted)]">Finding or creating a drill-* project to stage the pass on. Real projects are never touched.</div>
      </WizardFrame>
    );
  }

  if (phase.kind === "refused") {
    return (
      <WizardFrame icon={<ClipboardCheck size={17} />} title="Drill Mode" sub="Not started" index={0} total={total} layout="dock" footer={stopButton}>
        <div role="alert" className="tr-card px-4 py-3 text-[12.5px] text-[var(--color-tr-fail)]">{phase.why}</div>
      </WizardFrame>
    );
  }

  if (phase.kind === "finished") {
    return (
      <WizardFrame icon={<ClipboardCheck size={17} />} title="Drill complete" sub={`on ${phase.project}`} index={total - 1} total={total} layout="dock"
        footer={
          <button type="button" onClick={close}
            className="flex items-center gap-1 rounded-lg bg-tr-doing/20 px-4 py-1.5 text-[12.5px] font-semibold text-tr-doing hover:bg-tr-doing/30">
            Close <ChevronRight size={14} />
          </button>
        }>
        <div className="text-[13px] font-medium" data-testid="drill-summary">{summarize(outcomes, total)}</div>
        <ul className="mt-3 flex flex-col gap-1.5 text-[12px]">
          {outcomes.map(o => (
            <li key={o.card} className="flex items-center gap-2">
              {o.verdict === "pass" ? <CheckCircle2 size={13} className="text-tr-ok" /> : <XCircle size={13} className="text-[var(--color-tr-fail)]" />}
              <span className="tr-mono">#{o.card}</span>
              <span className="text-[var(--color-tr-muted)]">{o.verdict === "pass" ? "done" : "back to doing"}</span>
              {o.screenshot && <span className="tr-mono min-w-0 truncate text-[11px] text-[var(--color-tr-muted)]" title={o.screenshot}>{o.screenshot}</span>}
            </li>
          ))}
        </ul>
      </WizardFrame>
    );
  }

  return (
    <WizardFrame
      icon={<ClipboardCheck size={17} />}
      title={`#${step.card} — ${step.title}`}
      sub={`Drill on ${phase.project}`}
      index={index}
      total={total}
      layout="dock"
      hidden={capturing}
      footer={
        <>
          {stopButton}
          <button type="button" onClick={skip} disabled={busy} className="tr-input disabled:opacity-40">Skip</button>
          <button type="button" onClick={() => void decide("fail")} disabled={busy}
            className="flex items-center gap-1 rounded-lg bg-[var(--color-tr-fail)]/20 px-3.5 py-1.5 text-[12.5px] font-semibold text-[var(--color-tr-fail)] hover:bg-[var(--color-tr-fail)]/30 disabled:opacity-40">
            <XCircle size={13} /> Fail
          </button>
          <button type="button" onClick={() => void decide("pass")} disabled={busy}
            className="flex items-center gap-1 rounded-lg bg-tr-doing/20 px-4 py-1.5 text-[12.5px] font-semibold text-tr-doing hover:bg-tr-doing/30 disabled:opacity-40">
            <CheckCircle2 size={13} /> {busy ? "Recording…" : "Pass"}
          </button>
        </>
      }>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div>
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-tr-muted)]">Do this</div>
          <div className="mt-1" data-testid="drill-action">{step.action}</div>
          {step.drive && (
            <button type="button" onClick={() => void drive()} disabled={busy || driving} data-testid="drill-drive"
              className="tr-input mt-2 flex items-center gap-1.5 disabled:opacity-40">
              <Play size={12} /> {driving ? "Driving…" : DRIVE_LABELS[step.drive]}
            </button>
          )}
        </div>
        <div>
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-tr-muted)]">You should see</div>
          <div className="mt-1" data-testid="drill-expected">{step.expected}</div>
        </div>
        {(step.autoCheck || step.drive) && (
          <div className={`tr-card flex items-center gap-2 px-3 py-2 ${auto?.ok ? "text-tr-ok" : "text-[var(--color-tr-muted)]"}`} data-testid="drill-auto-check">
            {auto?.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            <span className="min-w-0 flex-1">
              {auto?.ok ? `Auto-check says pass (${auto.why}) — confirm with your own eyes.` : `Auto-check: ${auto?.why ?? "not run"}`}
            </span>
            {step.autoCheck && <button type="button" onClick={recheck} className="tr-input shrink-0 text-[11px]">Check now</button>}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-tr-muted)]">Note (goes on the card)</span>
          <textarea value={operatorNote} onChange={e => setOperatorNote(e.target.value)} rows={2}
            placeholder="What you saw, if it differs from the expected result"
            className="tr-input resize-none text-[12px]" data-testid="drill-note" />
        </label>
        {error && <div role="alert" className="text-[12px] text-[var(--color-tr-fail)]">{error}</div>}
      </div>
    </WizardFrame>
  );
}
