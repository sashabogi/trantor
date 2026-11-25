// The Output tab: the app's own logs, followed live while the tab is on screen (#14081).
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type OutputChannel = "app-trace" | "app-errors" | "crashes";
export type OutputLogPage = { lines: string[]; offset: number; missing: boolean; reset: boolean };
export const OUTPUT_CHANNEL_KEY = "trantor.v2.bottomPanel.outputChannel";
export const MAX_OUTPUT_LINES = 5_000;

const CHANNELS: { id: OutputChannel; label: string }[] = [
  { id: "app-trace", label: "App trace" },
  { id: "app-errors", label: "App errors" },
  { id: "crashes", label: "Crashes" },
];

function isOutputChannel(value: string | null): value is OutputChannel {
  return CHANNELS.some(channel => channel.id === value);
}

function rememberedChannel(): OutputChannel {
  try {
    const saved = localStorage.getItem(OUTPUT_CHANNEL_KEY);
    if (isOutputChannel(saved)) return saved;
  } catch { /* storage blocked: use the default for this session */ }
  return "app-trace";
}

export function mergeOutputLines(current: string[], page: OutputLogPage): string[] {
  return [...(page.reset ? [] : current), ...page.lines].slice(-MAX_OUTPUT_LINES);
}

function scrollToLatest(element: HTMLElement | null) {
  if (element) element.scrollTop = element.scrollHeight;
}

export function Output() {
  const [channel, setChannel] = useState<OutputChannel>(rememberedChannel);
  const [lines, setLines] = useState<string[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const offset = useRef<number | null>(null);
  const generation = useRef(0);
  const follow = useRef(true);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    offset.current = null;
    follow.current = true;
    setFollowing(true);
    setLines([]);
    setMissing(false);
    setError(null);

    const poll = async () => {
      if (busy) return;
      busy = true;
      const requestedGeneration = generation.current;
      try {
        const raw = await invoke<string>("output_log_read", { channel, offset: offset.current });
        if (stopped) return;
        // SAFETY: output_log_read serialises exactly OutputLogPage from output_log.rs.
        const page = JSON.parse(raw) as OutputLogPage;
        offset.current = page.offset;
        if (requestedGeneration !== generation.current) return;
        setMissing(page.missing);
        setError(null);
        setLines(current => mergeOutputLines(current, page));
      } catch (reason) {
        if (!stopped && requestedGeneration === generation.current) setError(String(reason));
      } finally {
        busy = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1_000);
    return () => {
      stopped = true;
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [channel]);

  useLayoutEffect(() => {
    if (follow.current) scrollToLatest(scroller.current);
  }, [channel, lines]);

  const chooseChannel = (value: string) => {
    if (!isOutputChannel(value)) return;
    const next = value;
    setChannel(next);
    try { localStorage.setItem(OUTPUT_CHANNEL_KEY, next); } catch { /* storage blocked: keep the session choice */ }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="output-panel">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-[var(--v2-edge)] px-2">
        {error && <div role="alert" className="mr-auto truncate text-v2-small text-[var(--v2-bad)]" title={error}>{error}</div>}
        <button type="button" aria-label="Clear output" title="Clear output"
          onClick={() => { generation.current += 1; setLines([]); setError(null); }}
          className="v2-hover inline-flex h-6 items-center gap-1 rounded-md px-2 text-v2-small text-[var(--v2-muted)]">
          <Trash2 size={12} aria-hidden /> Clear
        </button>
        <select aria-label="Output channel" value={channel} onChange={event => chooseChannel(event.target.value)}
          className="h-6 rounded-md border border-[var(--v2-edge)] bg-[var(--v2-panel)] px-1.5 text-v2-small text-[var(--v2-text)] outline-none">
          {CHANNELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} role="log" aria-label={`${CHANNELS.find(item => item.id === channel)?.label} output`}
          data-testid="output-log"
          onScroll={event => {
            const element = event.currentTarget;
            const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 16;
            follow.current = atBottom;
            setFollowing(atBottom);
          }}
          className="h-full overflow-auto px-3 py-2 font-mono text-v2-small leading-[1.55] text-[var(--v2-text-2)]">
          {missing
            ? <p className="font-sans text-[var(--v2-muted)]">Nothing has been written here yet.</p>
            : lines.map((line, index) => <div key={`${index}:${line}`} className="whitespace-pre">{line || " "}</div>)}
        </div>
        {!following && (
          <button type="button" onClick={() => { follow.current = true; setFollowing(true); scrollToLatest(scroller.current); }}
            className="absolute bottom-3 right-4 inline-flex items-center gap-1.5 rounded-full border border-[var(--v2-edge)] bg-[var(--v2-raised)] px-3 py-1.5 text-v2-small text-[var(--v2-text)] shadow-lg">
            <ArrowDown size={12} aria-hidden /> Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
