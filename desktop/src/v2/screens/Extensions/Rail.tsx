// Left rail: categories, the installed list with health dots, and the who-installs note (#13993).
import { useEffect, useState } from "react";
import type { BalanceEntry, HubClient } from "../../../shared/api/client";
import { monogram } from "../../ui/identity";

export type Category = "all" | "editor" | "mcp" | "skills" | "plugins" | "providers";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "editor", label: "Editor extensions" },
  { id: "mcp", label: "Agent tools (MCP)" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
  { id: "providers", label: "Model providers" },
];

type Health = "ok" | "warn" | "bad";
const DOT = { ok: "var(--v2-ok)", warn: "var(--v2-warn)", bad: "var(--v2-bad)" } as const satisfies Record<Health, string>;
const DOT_LABEL = { ok: "on", warn: "running low", bad: "failed to read" } as const satisfies Record<Health, string>;

export function providerHealth(e: BalanceEntry): Health {
  if (!e.ok) return "bad";
  return e.low ? "warn" : "ok";
}

/** Model providers are the one installed set the hub can already read: balances (#13993). */
export function useProviders(client: HubClient): BalanceEntry[] | null {
  const [entries, setEntries] = useState<BalanceEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    client.balances().then(r => { if (alive) setEntries(r.entries); }).catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, [client]);
  return entries;
}

type RailProps = {
  category: Category; onCategory: (c: Category) => void;
  openVsxTotal: number | null; providers: BalanceEntry[] | null;
};

export function Rail({ category, onCategory, openVsxTotal, providers }: RailProps) {
  const failing = providers?.filter(p => providerHealth(p) === "bad").length ?? 0;
  const count = (c: Category): string => {
    if (c === "editor") return openVsxTotal === null ? "Open VSX" : `${openVsxTotal.toLocaleString("en-US")} on Open VSX`;
    if (c === "providers") return providers ? String(providers.length) : "";
    return "";
  };
  return (
    <aside aria-label="Extension categories" className="flex w-[232px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--v2-edge)] bg-[var(--v2-chrome)] p-3">
      <div className="px-1.5 pb-2">
        <h1 className="m-0 text-v2-title font-[650]">Extensions and tools</h1>
        <div className="mt-0.5 text-v2-body text-[var(--v2-muted)]">for your editor and for your agents</div>
      </div>
      {CATEGORIES.map(c => (
        <button key={c.id} type="button" aria-current={category === c.id ? "page" : undefined} onClick={() => onCategory(c.id)}
          className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-[7px] text-left text-v2-base ${category === c.id ? "bg-[var(--v2-raised)] text-[var(--v2-text)]" : "text-[var(--v2-text-2)] hover:bg-[var(--v2-panel-2)]"}`}>
          <span>{c.label}</span>
          <span className="text-v2-small text-[var(--v2-muted)]">{count(c.id)}</span>
        </button>
      ))}
      <div className="mt-3 flex items-center justify-between px-1.5 text-v2-small font-semibold tracking-wide text-[var(--v2-muted)]">
        <span>INSTALLED</span>
        <span>{failing > 0 ? `${failing} failing` : ""}</span>
      </div>
      <InstalledList providers={providers} />
      <div className="mt-auto rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)] p-2.5 text-v2-body leading-snug text-[var(--v2-muted)]">
        Only you install. Seats can ask for a tool; it lands in your Inbox.
      </div>
    </aside>
  );
}

function InstalledList({ providers }: { providers: BalanceEntry[] | null }) {
  if (providers === null) return <div className="px-1.5 text-v2-body text-[var(--v2-muted)]">Reading what is installed...</div>;
  if (providers.length === 0) return <div className="px-1.5 text-v2-body text-[var(--v2-muted)]">Nothing readable as installed yet.</div>;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {providers.map(p => {
        const name = p.label ?? p.provider;
        const h = providerHealth(p);
        return (
          <li key={p.provider} className="flex items-center gap-2 px-1.5 py-[5px] text-v2-base">
            <span aria-hidden className="v2-mono flex h-[22px] w-[22px] items-center justify-center rounded-md bg-[var(--v2-panel-2)] text-v2-micro text-[var(--v2-text-2)]">{monogram(name)}</span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span role="img" aria-label={DOT_LABEL[h]} title={DOT_LABEL[h]} className="h-2 w-2 rounded-full" style={{ background: DOT[h] }} />
          </li>
        );
      })}
    </ul>
  );
}
