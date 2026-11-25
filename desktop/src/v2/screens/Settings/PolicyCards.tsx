// Static policy copy under the dials, from the artboard (#13994).
import { Lock } from "lucide-react";
import { Chip } from "../../ui/Chip";
import { Checkbox } from "../../ui/Checkbox";
import { Section } from "../../ui/Section";

const NEVER_AUTO = [
  "force-push", "push to main", "delete a branch with unlanded commits", "rm -rf outside the worktree", "hard reset",
  "touch SSH keys or credentials", "pipe a download into a shell", "log into a provider", "launch or quit the app",
] as const;

const AGREEMENTS = [
  { title: "One card, one branch", body: "A seat works on seat/<name> in its own worktree; never on main." },
  { title: "The drill is the gate", body: "Done is refused until the drill ran on the built thing and its result is on the card." },
  { title: "Red blocks merge", body: "A red suite blocks merge; a flaky test is fixed or deleted within a week." },
  { title: "Map the blast radius first", body: "List callers before a rename, move or delete." },
  { title: "Seats never touch your live surfaces", body: "No app launches, provider logins, or trantor up and down." },
  { title: "Turn ends with a commit", body: "Uncommitted work does not exist." },
] as const;

export function AlwaysAsks() {
  return (
    <Section title="Always asks, at every level" sub="These never get an Always button, even in full auto. The prompt says why.">
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {NEVER_AUTO.map(t => (
          <li key={t}><Chip tone="bad" icon={<Lock size={10} aria-hidden="true" />}>{t}</Chip></li>
        ))}
      </ul>
    </Section>
  );
}

export function WorkingAgreements() {
  return (
    <Section title="Working agreements" sub="Written into every seat's contract. Code that breaks one is the bug."
      actions={<Chip mono>from docs/BUILD-DOCTRINE.md</Chip>}>
      <div className="flex flex-col gap-2.5">
        {AGREEMENTS.map(a => (
          <label key={a.title} className="flex items-start gap-2.5" title="Edited in BUILD-DOCTRINE.md, not here">
            <Checkbox checked disabled readOnly aria-label={`${a.title}, edited in BUILD-DOCTRINE.md`} className="mt-[3px]" />
            <span className="flex flex-col">
              <span className="text-[12.5px] text-[var(--v2-text)]">{a.title}</span>
              <span className="text-[11.5px] text-[var(--v2-muted)]">{a.body}</span>
            </span>
          </label>
        ))}
      </div>
    </Section>
  );
}
