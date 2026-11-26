// The Dashboard's empty state: no projects yet, one way forward (#13984).
import { FolderPlus } from "lucide-react";

export function StartCard({ onStart }: { onStart?: () => void }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <section aria-label="Start a project" className="w-[420px] max-w-full rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel)] p-6 text-center">
        <FolderPlus size={26} aria-hidden className="mx-auto text-[var(--v2-accent)]" />
        <h1 className="m-0 mt-3 text-v2-heading font-[650] text-[var(--v2-text)]">Start a project</h1>
        <p className="m-0 mt-2 text-v2-base leading-relaxed text-[var(--v2-muted)]">
          No projects yet. Start Blank to name an empty project and tell the orchestrator what to build, or start From a brief:
          paste or drop a PRD and the crew reviews it before anything is built.
        </p>
        {onStart && (
          <button type="button" onClick={onStart}
            className="mt-4 rounded-lg border-0 bg-[var(--v2-accent)] px-4 py-2 text-v2-base font-semibold text-[var(--v2-ink)]">
            Start a project
          </button>
        )}
      </section>
    </div>
  );
}
