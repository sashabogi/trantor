// Add a seat: each plan's state from balances, and the same picker the Workspace strip uses (#14050).
import { Plus } from "lucide-react";
import type { BalancesReport } from "../../../shared/api/client";
import { Button, modelHue } from "../../index";
import { entryForVendor, planLine } from "./model";
import { SeatPicker } from "./SeatPicker";
import type { Crew } from "../Workspace/useCrew";

const VENDORS = ["Codex", "Kimi", "GLM", "DeepSeek", "Claude"] as const;
const TONE = { ok: "var(--v2-ok)", warn: "var(--v2-warn)", bad: "var(--v2-bad)", none: "var(--v2-muted)" } as const;

export function AddSeat({ report, crew }: { report: BalancesReport | null; crew: Crew }) {
  return (
    <section aria-label="Add a seat" className="rounded-xl border border-dashed border-[var(--v2-edge-2)] bg-[var(--v2-panel)] p-3">
      <div className="mb-2.5 flex items-center gap-2 text-v2-base font-semibold"><Plus size={14} aria-hidden />Add a seat</div>
      <div className="flex flex-wrap gap-2">
        {VENDORS.map(v => {
          const own = v === "Claude";
          const plan = own ? { tone: "none" as const, line: "your Claude plan" } : planLine(entryForVendor(v, report));
          return (
            <span key={v} title={own ? "Uses your Claude plan" : `${v} plan: ${plan.line}`}
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--v2-edge-2)] px-2.5 py-1.5 text-v2-body text-[var(--v2-text)]">
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: modelHue(v) }} />
              {v}
              <span className="text-v2-small" style={{ color: TONE[plan.tone] }}>{plan.line}</span>
            </span>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="flex-1" />
        <SeatPicker crew={crew} trigger={p => (
          <Button variant="primary" {...p} icon={<Plus size={13} />}>Start seat</Button>
        )} />
      </div>
    </section>
  );
}
