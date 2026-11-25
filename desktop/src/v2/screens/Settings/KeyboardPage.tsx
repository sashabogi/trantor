// The Keyboard page: every shortcut in the command registry, grouped, read only.
import { useMemo } from "react";
import { GROUP_ORDER, useCommands, type Command } from "../../shell/commands";
import { formatShortcut } from "../../shell/shortcuts";
import { Kbd } from "../../ui/Kbd";

function groupShortcuts(all: Command[]): [string, Command[]][] {
  const groups = new Map<string, Command[]>();
  for (const command of all) if (command.shortcut) groups.set(command.group, [...(groups.get(command.group) ?? []), command]);
  const rank = (name: string) => { const i = GROUP_ORDER.indexOf(name); return i < 0 ? GROUP_ORDER.length : i; };
  return [...groups].sort((a, b) => rank(a[0]) - rank(b[0]));
}

export function KeyboardPage() {
  const all = useCommands();
  const groups = useMemo(() => groupShortcuts(all), [all]);
  if (!groups.length) return <p className="text-[12.5px] text-[var(--v2-muted)]">No shortcuts are registered.</p>;
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([group, commands]) => (
        <section key={group} aria-label={group} className="overflow-hidden rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel)]">
          <h3 className="m-0 border-b border-[var(--v2-edge)] px-4 py-2 text-[11px] font-medium text-[var(--v2-muted)]">{group}</h3>
          <ul className="m-0 list-none p-0">
            {commands.map(command => (
              <li key={command.id} className="flex items-center justify-between gap-3 border-b border-[var(--v2-edge)] px-4 py-2 text-[12.5px] last:border-b-0">
                <span>{command.title}</span>
                <Kbd>{formatShortcut(command.shortcut ?? "")}</Kbd>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
