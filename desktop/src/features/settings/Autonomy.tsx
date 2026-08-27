// The three dials, in the app.
//
// Reads and writes through the CLI, never by touching autonomy.json directly: the dependency rules
// between dials live in one place, and the half that drifts would be the half deciding whether we
// push to a remote.
//
// The scope picker is not decoration. These settings apply per project on top of a global default,
// and a control that silently changed one when you meant the other would be the worst kind of
// wrong here.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Resolved = {
  harness: "prompt" | "bypass";
  commit: boolean;
  push: boolean;
  deploy: boolean;
  swapDeadSeat: boolean;
  retryFailedTurn: boolean;
};
type State = { project: string | null; resolved: Resolved; defaults: Resolved; overridden: string[]; path: string };

const ACTS: Array<{ key: keyof Resolved; label: string; why: string }> = [
  { key: "commit", label: "Commit landed work", why: "each seat's finished work is committed as that seat" },
  { key: "push", label: "Push after verifying", why: "integrated work goes to the remote once tests pass — needs commit" },
  { key: "deploy", label: "Deploy after pushing", why: "runs the project's deploy step — needs push" },
  { key: "swapDeadSeat", label: "Replace a dead seat", why: "swaps a seat that ran out of quota; loses nothing" },
  { key: "retryFailedTurn", label: "Retry a failed turn", why: "re-runs a turn that crashed, instead of leaving the seat idle" },
];

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-40"
      style={{ background: on ? "var(--color-tr-ok)" : "var(--color-tr-panel)" }}
    >
      <span
        className="absolute top-[3px] h-4 w-4 rounded-full bg-white transition-all"
        style={{ left: on ? 19 : 3 }}
      />
    </button>
  );
}

export function Autonomy({ projects }: { projects: string[] }) {
  const [scope, setScope] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke<string>("autonomy_get", { project: scope })
      .then(s => { setState(JSON.parse(s)); setError(null); })
      .catch(e => setError(String(e)));
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  const set = (dial: string, value: string) => {
    invoke<string>("autonomy_set", { project: scope, dial, value })
      .then(s => { setState(JSON.parse(s)); setError(null); })
      .catch(e => setError(String(e)));
  };

  if (error) return <div className="text-[12.5px] text-tr-danger">{error}</div>;
  if (!state) return <div className="text-[12.5px] text-tr-muted">reading…</div>;
  const a = state.resolved;
  const isSet = (k: string) => scope !== null && state.overridden.includes(k);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-[13px] font-semibold">Autonomy</div>
        <div className="mt-1 text-[12.5px] leading-relaxed text-tr-muted">
          How much Trantor does without asking, on this machine. What a crew AGENT may do
          unattended is set above, per project, because that one is shared with your team.
        </div>
      </div>

      {/* SCOPE. Defaults apply everywhere; a project overrides them. */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setScope(null)}
          data-on={scope === null}
          className="rounded-[9px] px-3 py-[6px] text-[12.5px] text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text"
        >
          every project
        </button>
        {projects.map(p => (
          <button
            key={p}
            type="button"
            onClick={() => setScope(p)}
            data-on={scope === p}
            className="rounded-[9px] px-3 py-[6px] text-[12.5px] text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text"
          >
            {p}
          </button>
        ))}
      </div>

      <Section title="Your session" sub="whether your own claude asks before it acts">
        <Choice
          value={a.harness}
          marked={isSet("harness")}
          options={[
            ["prompt", "ask me"],
            ["bypass", "skip permission prompts"],
          ]}
          onPick={v => set("harness", v)}
        />
        {a.harness === "bypass" && (
          <div className="mt-2 text-[11.5px] leading-relaxed text-tr-warn">
            Your session will act without asking. It takes effect the next time the session starts.
          </div>
        )}
      </Section>

      <Section title="Trantor itself" sub="what it does on your behalf">
        <div className="flex flex-col gap-2.5">
          {ACTS.map(({ key, label, why }) => {
            // push needs commit, deploy needs push. Disabling rather than hiding shows WHY the
            // control is unavailable instead of leaving a gap where a switch should be.
            const blocked = (key === "push" && !a.commit) || (key === "deploy" && !a.push);
            return (
              <div key={key} className="flex items-start gap-3">
                <Toggle
                  on={!!a[key]}
                  disabled={blocked}
                  onClick={() => set(key, a[key] ? "off" : "on")}
                />
                <div className="min-w-0">
                  <div className="text-[12.5px]">
                    {label}
                    {isSet(key) && <span className="ml-2 text-[11px] text-tr-muted">set for {scope}</span>}
                  </div>
                  <div className="text-[11.5px] leading-relaxed text-tr-muted">{why}</div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[11.5px] leading-relaxed text-tr-muted">
          Verified work only: a failing test run stops the push whatever these say.
        </div>
      </Section>

      <div className="tr-mono text-[11px] text-tr-muted">{state.path}</div>
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="tr-card px-4 py-3.5">
      <div className="text-[12.5px] font-medium">{title}</div>
      <div className="mb-3 text-[11.5px] text-tr-muted">{sub}</div>
      {children}
    </div>
  );
}

function Choice({ value, options, onPick, marked }: {
  value: string; options: Array<[string, string]>; onPick: (v: string) => void; marked: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onPick(v)}
          data-on={value === v}
          className="rounded-[8px] px-2.5 py-[5px] text-[12px] text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text"
        >
          {label}
        </button>
      ))}
      {marked && <span className="ml-1 text-[11px] text-tr-muted">overridden here</span>}
    </div>
  );
}
