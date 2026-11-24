// Add a seat: the vendor picker with each plan's real state from balances (#13992).
import { useState } from "react";
import { Plus } from "lucide-react";
import type { BalancesReport } from "../../../shared/api/client";
import { Button, modelHue } from "../../index";
import { entryForVendor, planLine } from "./model";

const VENDORS = ["Codex", "Kimi", "GLM", "DeepSeek", "Claude"] as const;
const TONE = { ok: "var(--v2-ok)", warn: "var(--v2-warn)", bad: "var(--v2-bad)", none: "var(--v2-muted)" } as const;

export function AddSeat({ report }: { report: BalancesReport | null }) {
  const [vendor, setVendor] = useState<string>("Codex");
  return (
    <section aria-label="Add a seat" className="rounded-xl border border-dashed border-[var(--v2-edge-2)] bg-[var(--v2-panel)] p-3">
      <div className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold"><Plus size={14} aria-hidden />Add a seat</div>
      <div className="flex flex-wrap gap-2">
        {VENDORS.map(v => {
          const own = v === "Claude";
          const plan = own ? { tone: "warn" as const, line: "your own quota" } : planLine(entryForVendor(v, report));
          return (
            <button key={v} type="button" aria-pressed={vendor === v} onClick={() => setVendor(v)}
              title={own ? "Draws your own Claude plan: avoid for crew work" : `${v} plan: ${plan.line}`}
              className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] ${vendor === v ? "border-[var(--v2-accent)] bg-[var(--v2-accent-soft)]" : "border-[var(--v2-edge-2)] bg-transparent"} text-[var(--v2-text)]`}>
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: modelHue(v) }} />
              {v}
              <span className="text-[11px]" style={{ color: TONE[plan.tone] }}>{plan.line}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="text-[11.5px] text-[var(--v2-muted)]">Seats start from the trantor CLI for now.</span>
        <span className="flex-1" />
        <Button variant="primary" disabledReason="Starting a seat is not wired yet: the app has no start-seat method, use trantor up">Start seat</Button>
      </div>
    </section>
  );
}
