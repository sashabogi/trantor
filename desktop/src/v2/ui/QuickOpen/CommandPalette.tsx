// The command palette (Cmd+Shift+P): every command that applies now, fuzzy matched, with its shortcut.
import { useMemo, useState } from "react";
import { availableCommands, filterCommands, useCommands, type Command } from "../../shell/commands";
import { formatShortcut } from "../../shell/shortcuts";
import { Kbd } from "../Kbd";
import { NOTE, Picker, ROW, rowTone, useListKeys } from "./Picker";

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const all = useCommands();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => filterCommands(availableCommands(all), query), [all, query]);
  const run = (command: Command) => { onClose(); command.run(); };
  const keys = useListKeys(rows.length, query, i => run(rows[i]), onClose);
  return (
    <Picker label="Command palette" placeholder="Type a command" query={query} onQuery={setQuery} onKeyDown={keys.onKeyDown} onClose={onClose}>
      <div role="listbox" aria-label="Commands" className="max-h-[46vh] overflow-y-auto py-1.5">
        {rows.map((command, i) => (
          <button key={command.id} type="button" role="option" aria-selected={i === keys.sel} onClick={() => run(command)} onMouseEnter={() => keys.setSel(i)}
            className={`${ROW} ${rowTone(i === keys.sel)}`}>
            <span className="min-w-0 flex-1 truncate">{command.title}</span>
            <span className="shrink-0 text-v2-small text-[var(--v2-muted)]">{command.group}</span>
            {command.shortcut && <Kbd>{formatShortcut(command.shortcut)}</Kbd>}
          </button>
        ))}
        {rows.length === 0 && <div className={NOTE}>No command matches.</div>}
      </div>
    </Picker>
  );
}
