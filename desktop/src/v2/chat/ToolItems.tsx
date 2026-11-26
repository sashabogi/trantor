// The transcript's tool rows (#14327): a run of calls folds into one quiet summary row, a lone call
// is a verb and what it acted on, a failed call opens itself, an edit is a small diff card. All the
// wording and grouping comes from toolGroups.ts; this file only draws it.
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, FilePlus, Folder, GitCommitHorizontal, ListChecks, Pencil, Terminal, Wrench, X, type LucideIcon } from "lucide-react";
import { singleRow, summary, type Call, type Item } from "../../features/chat/toolGroups";
import type { Block, ToolKind, ToolResult } from "../../features/chat/streaming";
import type { Link } from "../../shared/linkify";
import { FadeBox } from "./bits";
import { LinkAnchor } from "./Linked";
import { useLinks } from "./LinkContext";

const KIND_ICON = {
  explore: Folder, edit: Pencil, write: FilePlus, command: Terminal, commit: GitCommitHorizontal, todo: ListChecks, other: Wrench,
} as const satisfies Record<ToolKind, LucideIcon>;

const ROW = "flex min-h-[22px] items-center gap-2 rounded-sm px-1 hover:bg-[var(--v2-hover)]/40";
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function Glyph({ icon: Icon, tone = "muted", pulse = false }: { icon: LucideIcon; tone?: "muted" | "bad"; pulse?: boolean }) {
  return (
    <span aria-hidden className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${tone === "bad" ? "text-[var(--v2-bad)]" : pulse ? "text-[var(--v2-accent)]" : "text-[var(--v2-muted)]"} ${pulse ? "v2-pulse" : ""}`}>
      <Icon size={14} />
    </span>
  );
}

/** "820ms", "14.2s", "6m 05s". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// ---- one call ----------------------------------------------------------------
const pathLink = (path: string, label: string): Link => ({ kind: "path", href: path, label, pending: false });

/** The command or argument on a sunken line, the exit chip and time after it, the output below. */
function ToolDetail({ call }: { call: Call }) {
  const [all, setAll] = useState(false);
  const { block, result } = call;
  const preview = result?.preview ?? "";
  const lines = preview.split("\n");
  const long = lines.length > 8 || preview.length > 600;
  const shown = long && !all ? lines.slice(0, 8).join("\n").slice(0, 600) : preview;
  const code = result?.exit_code;
  return (
    <div data-testid="tool-detail" className="my-1 ml-3 overflow-hidden rounded-md border border-[var(--v2-edge)]">
      <div className="flex items-start gap-2 bg-[var(--v2-sunken)] px-2.5 py-1.5">
        <div className="v2-mono max-h-60 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words text-v2-body text-[var(--v2-text-2)]">
          {call.kind === "command" || call.kind === "commit" ? `$ ${block.text}` : `${block.tool ?? "tool"} ${block.text}`.trim()}
        </div>
        {result?.duration_ms !== undefined && <span className="v2-mono shrink-0 pt-px text-v2-micro text-[var(--v2-faint)]">{duration(result.duration_ms)}</span>}
        {code !== undefined && (
          <span data-testid="exit-chip" data-ok={code === 0 || undefined}
            className={`v2-mono shrink-0 rounded-sm px-1.5 py-px text-v2-micro ${code === 0 ? "bg-[var(--v2-ok-soft)] text-[var(--v2-ok)]" : "bg-[var(--v2-bad-soft)] text-[var(--v2-bad)]"}`}>
            exit {code}
          </span>
        )}
      </div>
      <div className="border-t border-[var(--v2-edge)] px-2.5 py-1.5">
        {result
          ? <pre className="v2-mono m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words text-v2-body leading-normal text-[var(--v2-muted)]">{preview ? shown : "(no output)"}</pre>
          : <div className="text-v2-small text-[var(--v2-muted)]">Still running</div>}
        {long && (
          <button type="button" onClick={() => setAll(a => !a)} className="mt-1 text-v2-small text-[var(--v2-link)] hover:underline">
            {all ? "Hide output" : "Show output"}
          </button>
        )}
      </div>
    </div>
  );
}

/** One call: a verb and what it acted on; running pulses, failed shows its output at once. */
export function ToolRow({ call, open: opensItself }: { call: Call; open: boolean }) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? opensItself;
  const toggle = () => setToggled(!open);
  const row = singleRow(call);
  const label = call.running ? summary([call]) : row.verb;
  const path = call.block.paths?.[0];
  const linked = path !== undefined && (call.kind === "explore" || call.kind === "edit" || call.kind === "write") && call.block.tool !== "Bash";
  const object = linked ? row.object : null;
  const Icon = call.failed ? X : KIND_ICON[call.kind];
  return (
    <div data-testid="tool-row" data-state={call.running ? "running" : call.failed ? "failed" : "ok"}>
      <div className={ROW}>
        <button type="button" aria-expanded={open} onClick={toggle} className={`flex min-w-0 items-center gap-2 text-left ${object === null ? "flex-1" : ""}`}>
          <Glyph icon={Icon} tone={call.failed ? "bad" : "muted"} pulse={call.running} />
          <span className="shrink-0 text-v2-body text-[var(--v2-muted)]">{label}</span>
          {object === null && <span className="v2-mono min-w-0 truncate text-v2-body font-medium text-[var(--v2-text-2)]">{row.object}</span>}
        </button>
        {object !== null && path !== undefined && (
          <>
            <LinkAnchor link={pathLink(path, object)} className="v2-mono min-w-0 truncate text-v2-body font-medium">{object}</LinkAnchor>
            <span aria-hidden className="h-full min-h-[22px] flex-1 cursor-pointer" onClick={toggle} />
          </>
        )}
      </div>
      {open && <ToolDetail call={call} />}
    </div>
  );
}

/** An edit or write that landed: the file, what it added and removed, and the changed lines. */
export function EditCard({ call }: { call: Call }) {
  const { openDiff, locate, project } = useLinks();
  const { block } = call;
  const path = block.paths?.[0] ?? block.path ?? "";
  const name = path ? baseName(path) : block.text;
  const [where, setWhere] = useState<"inside" | "outside" | "unknown">("unknown");
  useEffect(() => {
    if (!path) return;
    let alive = true;
    void locate(path).then(w => { if (alive) setWhere(w); });
    return () => { alive = false; };
  }, [path, locate]);
  const outside = where === "outside";
  return (
    <div data-testid="edit-card" className="my-0.5 mb-1 flex flex-col gap-1.5 rounded-lg border border-[var(--v2-edge)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        {path ? <LinkAnchor link={pathLink(path, name)} className="v2-mono min-w-0 truncate text-v2-body font-medium">{name}</LinkAnchor>
          : <span className="v2-mono min-w-0 truncate text-v2-body font-medium">{name}</span>}
        {block.added !== undefined && <span data-testid="edit-added" className="v2-mono text-v2-small text-[var(--v2-ok)]">+{block.added}</span>}
        {block.removed !== undefined && <span data-testid="edit-removed" className="v2-mono text-v2-small text-[var(--v2-bad)]">-{block.removed}</span>}
        <span className="flex-1" />
        {outside && <span data-testid="edit-outside" title={`${path} is not in ${project || "this project"}, so it does not show in Source Control`} className="text-v2-small text-[var(--v2-faint)]">outside {project || "the project"}</span>}
        {path && !outside && <button type="button" onClick={() => openDiff(path)} className="text-v2-small text-[var(--v2-link)] hover:underline">Open diff</button>}
      </div>
      {block.diff && block.diff.length > 0 && (
        <div className="v2-mono overflow-hidden rounded-sm text-v2-small leading-[1.55]">
          {block.diff.map((l, i) => (
            <div key={i} data-op={l.op} className={`whitespace-pre px-2 text-[var(--v2-text-2)] ${l.op === "+" ? "bg-[var(--v2-diff-add)]" : "bg-[var(--v2-diff-del)]"}`}>{l.op} {l.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A call as it belongs in the list: a landed edit is a card, anything else a row. */
function CallItem({ call, open }: { call: Call; open: boolean }) {
  if ((call.kind === "edit" || call.kind === "write") && !call.failed && !call.running) return <EditCard call={call} />;
  return <ToolRow call={call} open={open} />;
}

// ---- groups and folds --------------------------------------------------------
const dominant = (calls: Call[]): ToolKind => {
  const counts = new Map<ToolKind, number>();
  for (const c of calls) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
};

/** A summary row that opens onto its contents, closed until asked; the shared body of group and fold. */
function Collapsible({ calls, text, running, trail, children }: { calls: Call[]; text: string; running: boolean; trail?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className={`${ROW} w-full text-left`}>
        <Glyph icon={KIND_ICON[dominant(calls)]} pulse={running} />
        <span className="text-v2-body text-[var(--v2-muted)]">{text}</span>
        <span className="flex-1" />
        <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--v2-muted)] opacity-55 transition-transform duration-[var(--v2-dur-1)] ease-[var(--v2-ease)]"
          style={{ transform: open ? "rotate(90deg)" : undefined }} />
      </button>
      {open && <div className="ml-2 mt-0.5 border-l border-[var(--v2-edge)] pl-2.5"><FadeBox max={360} className="flex flex-col gap-0.5">{children}</FadeBox></div>}
      {trail && <div aria-hidden data-testid="fold-trail" className="mb-1.5 mt-1 h-px" style={{ background: "var(--v2-hairline-fade)" }} />}
    </div>
  );
}

export function GroupRow({ calls, text, running }: { calls: Call[]; text: string; running: boolean }) {
  return (
    <Collapsible calls={calls} text={text} running={running}>
      {calls.map((c, i) => <CallItem key={i} call={c} open={false} />)}
    </Collapsible>
  );
}

/** A finished turn's work, folded above its reply into one row. */
export function FoldRow({ calls, text, items }: { calls: Call[]; text: string; items: Item[] }) {
  return (
    <Collapsible calls={calls} text={text} running={false} trail>
      {items.map((it, i) => <ItemView key={i} item={it} />)}
    </Collapsible>
  );
}

/** Reasoning the model wrote, quiet and closed until asked. */
export function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className={`${ROW} text-left text-v2-body text-[var(--v2-muted)]`}>
        <ChevronRight size={12} aria-hidden className="shrink-0 transition-transform duration-[var(--v2-dur-1)] ease-[var(--v2-ease)]" style={{ transform: open ? "rotate(90deg)" : undefined }} />
        Thinking
      </button>
      {open && <div className="my-1 ml-3 whitespace-pre-wrap break-words rounded-md bg-[var(--v2-sunken)] px-2.5 py-2 text-v2-body leading-relaxed text-[var(--v2-muted)]">{text}</div>}
    </div>
  );
}

/** An answered question, read-only: the header and what was picked. */
export function AskedRow({ block, result }: { block: Block; result: ToolResult | undefined }) {
  const q = block.ask?.[0];
  if (!q || !result) return null;
  return (
    <div data-testid="asked-row" className="rounded-lg border border-[var(--v2-edge)] px-3 py-2">
      <div className="flex items-center gap-2 text-v2-body font-medium">
        <span>{q.header || "Question"}</span>
        <span className="text-v2-small font-normal text-[var(--v2-muted)]">answered</span>
      </div>
      <div className="mt-0.5 text-v2-body text-[var(--v2-muted)]">{result.preview || q.question}</div>
    </div>
  );
}

/** Everything in a turn that is not prose: rows, groups, folds, thinking, questions and images. */
export function ItemView({ item }: { item: Item }) {
  if (item.type === "call") return <CallItem call={item.call} open={item.open} />;
  if (item.type === "group") return <GroupRow calls={item.calls} text={item.summary} running={item.running} />;
  if (item.type === "fold") return <FoldRow calls={item.calls} text={item.summary} items={item.items} />;
  const b = item.block;
  if (b.kind === "thinking") return <ThinkingRow text={b.text} />;
  if (b.kind === "image") return <div className="text-v2-small text-[var(--v2-muted)]">[image]</div>;
  return null;
}
