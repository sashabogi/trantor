import { useReviewScope } from "../../ui/ScmSidebar/reviewScope";
// #14256: git remains visible even when GitHub CLI cannot report CI.
import { CheckoutRecovery } from "../../ui/CheckoutRecovery";
import type { Navigate } from "../../routes";
import { Check, LoaderCircle, LockKeyhole } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ago } from "../../../shared/time";
import { aheadLabel } from "../../../features/code/gitApi";
import type { ScopeSnapshot } from "../../screens/Code/useScopeGit";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import type { CiStatus } from "./useBandData";

export function CiChip({ status }: { status: CiStatus | null }) {
  if (!status?.hasRemote) return null;
  const ci = status.ci;
  const running = ci?.state === "running";
  const red = ci?.state === "red";
  const label = running ? "CI running" : red ? ci.failing || "CI failed" : ci?.state === "green" ? "CI passed" : "CI unavailable";
  const icon = running ? <LoaderCircle size={10} className="motion-safe:animate-spin" aria-hidden="true" />
    : ci?.state === "green" ? <Check size={10} aria-hidden="true" /> : undefined;
  return (
    <Button variant="quiet" className="min-w-0 !p-0" aria-label={label} title={label}
      disabledReason={ci?.url ? null : "No CI run available"} onClick={() => { if (ci?.url) void openUrl(ci.url); }}>
      <Chip tone={red ? "bad" : "neutral"} icon={icon}><span className="max-w-24 truncate">{red ? label : "CI"}</span></Chip>
    </Button>
  );
}

export function MainHealth({ snap, status, project, onNavigate, gitFailed = false }: { project: string; onNavigate: Navigate; snap: ScopeSnapshot | null; status: CiStatus | null; gitFailed?: boolean }) {
  const review = useReviewScope(project);
  const missingCheckout = status?.localCheckout === false;
  const tag = status?.hasRemote ? status.tag : null;
  const published = status?.tagPublishedAt ? Date.parse(status.tagPublishedAt) : NaN;
  const release = tag ? `released ${tag}${Number.isFinite(published) ? ` · ${ago(published)}` : ""}` : null;
  if (review) return <div aria-label="Review scope" className="flex h-full min-w-0 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--v2-accent-edge)] bg-[var(--v2-info-soft)] px-2 text-v2-body">
    <LockKeyhole size={12} aria-hidden /><span className="truncate">Reviewing {review.name}</span><span aria-hidden>·</span><Button variant="quiet" onClick={review.back}>Back</Button>
  </div>;
  return (
    <div aria-label="Main checkout health" className="flex h-full min-w-0 max-w-64 shrink-0 flex-col justify-center rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)] px-2">
      <div className="flex min-w-0 items-center gap-2 text-v2-small">
        <span className="v2-mono truncate" title={snap?.branch ?? undefined}>{missingCheckout ? "No local checkout" : snap ? snap.branch || "detached" : gitFailed ? "Git unavailable" : "Reading git"}</span>
        <span className="truncate text-[var(--v2-muted)]">{snap ? aheadLabel(snap) : ""}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        {missingCheckout ? <CheckoutRecovery compact project={project} onNavigate={onNavigate} /> : <CiChip status={status} />}
        {release && <span className="v2-mono truncate text-v2-small text-[var(--v2-muted)]" title={release}>{release}</span>}
      </div>
    </div>
  );
}
