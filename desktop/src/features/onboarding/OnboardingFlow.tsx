// The first-run wizard. Four steps, each shown only when its own condition is not already met —
// a machine that arrives with Codex already connected and a hub already pinned sees only the
// steps that still apply, which for most upgrades is none at all (see onboardingState.ts and
// onboarding.rs's migration rule).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import { onboardingApi, type OnboardingApi } from "./onboardingApi";
import {
  AUTONOMY_DEFAULTS,
  ONBOARDING_STEPS,
  isAutonomyStepSatisfied,
  isIdentityStepSatisfied,
  isProjectStepSatisfied,
  isProvidersStepSatisfied,
  type AutonomyResolved,
  type OnboardingStep,
} from "./onboardingState";
import { AccountsPane } from "../settings/providers/AccountsPane";
import { providerAccountsApi, type ProviderAccountsApi, type ProviderStatus } from "../settings/providers/providerStatus";
import { Autonomy } from "../settings/Autonomy";
import { GenesisSheet } from "../genesis/GenesisSheet";

export type OnboardingFlowDeps = {
  api: OnboardingApi;
  providerApi: ProviderAccountsApi;
  knownProjects: () => Promise<string[]>;
  autonomyResolved: (project: string | null) => Promise<AutonomyResolved>;
  devRoot: () => Promise<string>;
};

export const DEFAULT_ONBOARDING_DEPS: OnboardingFlowDeps = {
  api: onboardingApi,
  providerApi: providerAccountsApi,
  knownProjects: () => invoke<string[]>("known_projects"),
  autonomyResolved: async project => {
    const raw = await invoke<string>("autonomy_get", { project });
    const parsed: { resolved: AutonomyResolved } = JSON.parse(raw);
    return parsed.resolved;
  },
  devRoot: () => invoke<string>("project_dev_root"),
};

const STEP_COPY = {
  providers: { title: "Connect a provider", sub: "One system login per provider — this is what your sessions and crews will run on." },
  identity: { title: "Identity and hub", sub: "Who this app signs as, and where its projects live." },
  autonomy: { title: "Autonomy", sub: "How much Trantor does without asking, on this machine." },
  project: { title: "Start a project", sub: "Create a repo or open one you already have." },
} satisfies Record<OnboardingStep, { title: string; sub: string }>;

export function OnboardingFlow({ me, project, onClose, deps = DEFAULT_ONBOARDING_DEPS }: {
  me: string;
  project: string;
  onClose: () => void;
  deps?: OnboardingFlowDeps;
}) {
  const { api, providerApi, knownProjects, autonomyResolved, devRoot } = deps;
  const [visible, setVisible] = useState<OnboardingStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [hasHubPin, setHasHubPin] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [genesisRoot, setGenesisRoot] = useState<string | null>(null);

  // Computed once, at mount: which steps still apply. A step's own live state (a provider login
  // completing, a project getting created) advances past it explicitly via Continue, not by this
  // set silently shrinking under the operator mid-flow.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [providerList, pinned, resolved, projectList] = await Promise.all([
        providerApi.status().catch((): ProviderStatus[] => []),
        api.hasHubPin().catch(() => false),
        autonomyResolved(null).catch((): AutonomyResolved => ({ ...AUTONOMY_DEFAULTS })),
        knownProjects().catch((): string[] => []),
      ]);
      if (!alive) return;
      setProviders(providerList);
      setHasHubPin(pinned);
      setProjects(projectList);
      const satisfied = {
        providers: isProvidersStepSatisfied(providerList),
        identity: isIdentityStepSatisfied(pinned),
        autonomy: isAutonomyStepSatisfied(resolved),
        project: isProjectStepSatisfied(projectList.length),
      } satisfies Record<OnboardingStep, boolean>;
      const steps = ONBOARDING_STEPS.filter(s => !satisfied[s]);
      if (steps.length === 0) {
        await api.close().catch(() => {});
        onClose();
        return;
      }
      setVisible(steps);
    })();
    return () => { alive = false; };
    // deps identity is stable across the wizard's lifetime; re-running on it would restart the flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 1 is the one step whose own satisfaction can change WHILE it is showing (a login
  // completes). Poll lightly only while it is the active step, same cadence Settings.tsx uses
  // for its own live provider/hub reads.
  useEffect(() => {
    if (!visible || visible[index] !== "providers") return;
    const t = setInterval(() => { void providerApi.status().then(setProviders).catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, [visible, index, providerApi]);

  if (!visible) return null;
  const step = visible[index];
  const last = index === visible.length - 1;
  const providersOk = isProvidersStepSatisfied(providers);
  const canContinue = step === "providers" ? providersOk : step === "project" ? projects.length > 0 : true;

  const advance = async () => {
    await api.setStep(step).catch(() => {});
    if (last) {
      await api.close().catch(() => {});
      onClose();
      return;
    }
    setIndex(i => i + 1);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-tr-bg)]">
      <div className="tr-card flex max-h-[86vh] w-[640px] max-w-[calc(100vw-48px)] flex-col overflow-hidden p-0 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-[var(--color-tr-edge)] px-6 py-4">
          <span className="rounded-lg bg-tr-doing/10 p-2 text-tr-doing"><Sparkles size={17} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">{STEP_COPY[step].title}</div>
            <div className="mt-0.5 text-[11.5px] text-[var(--color-tr-muted)]">{STEP_COPY[step].sub}</div>
          </div>
          <div className="tr-mono shrink-0 text-[11px] text-[var(--color-tr-muted)]">{index + 1} / {visible.length}</div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === "providers" && (
            <>
              <AccountsPane project={project} api={providerApi} />
              {providersOk && (
                <div className="tr-card mt-3 flex items-center gap-2 px-4 py-3 text-[12.5px] text-tr-ok">
                  <CheckCircle2 size={15} /> Connected — ready to continue.
                </div>
              )}
            </>
          )}
          {step === "identity" && (
            <div className="tr-card px-4 py-3.5">
              <div className="text-[13px] font-medium">{me}</div>
              <div className="mt-1 text-[12px] text-[var(--color-tr-muted)]">
                Every request this app makes is signed as you. Projects route to a hub —{" "}
                {hasHubPin ? "you already have one pinned." : "the machine-local one by default, or a shared one once you run "}
                {!hasHubPin && <code>trantor hub set &lt;project&gt; &lt;url&gt;</code>}
                {!hasHubPin && "."} You can change either later in Settings.
              </div>
            </div>
          )}
          {step === "autonomy" && <Autonomy projects={projects} />}
          {step === "project" && (
            <div className="tr-card-ghost flex flex-col items-center gap-3 p-8 text-center">
              <div className="text-[13px] text-[var(--color-tr-muted)]">
                {projects.length > 0 ? "A project is ready." : "Create a repo, or open one you already have."}
              </div>
              {projects.length === 0 && (
                <button type="button"
                  onClick={() => { void devRoot().then(setGenesisRoot); }}
                  className="rounded-lg bg-tr-doing/20 px-4 py-2 text-[13px] font-semibold text-tr-doing hover:bg-tr-doing/30">
                  Start a project
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-tr-edge)] px-6 py-3">
          <button type="button" onClick={() => void advance()} disabled={!canContinue}
            className="flex items-center gap-1 rounded-lg bg-tr-doing/20 px-4 py-1.5 text-[12.5px] font-semibold text-tr-doing hover:bg-tr-doing/30 disabled:opacity-40">
            {last ? "Done" : "Continue"} <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {genesisRoot !== null && (
        <GenesisSheet
          devRoot={genesisRoot}
          onClose={() => setGenesisRoot(null)}
          onMade={p => setProjects(prev => [...new Set([...prev, p])].sort())}
          onCreated={() => {
            setGenesisRoot(null);
            void advance();
          }}
        />
      )}
    </div>
  );
}
