// Developer mode's bottom panel frame; terminal and output bodies arrive as props (#14071).
import { useEffect, useRef, type ReactNode } from "react";
import { Maximize2, Minimize2, PanelBottomOpen, X } from "lucide-react";
import { useShellMode } from "../../shell/shellMode";
import { clampHeight, useBottomPanelState, type BottomPanelTab } from "./state";
import { ResizeHandle } from "./ResizeHandle";

type PanelTab = { id: BottomPanelTab; label: string; body: ReactNode };

export function BottomPanel({ terminal, output }: { terminal?: ReactNode; output?: ReactNode }) {
  const mode = useShellMode();
  const state = useBottomPanelState(mode);
  const panel = useRef<HTMLElement | null>(null);
  const tabs = ([
    { id: "terminal", label: "Terminal", body: terminal },
    { id: "output", label: "Output", body: output },
  ] satisfies PanelTab[]).filter(tab => tab.body !== undefined && tab.body !== null);
  const selected = tabs.find(tab => tab.id === state.activeTab) ?? tabs[0];
  const columnHeight = () => panel.current?.parentElement?.getBoundingClientRect().height || window.innerHeight;
  const height = clampHeight(state.height, columnHeight());

  useEffect(() => {
    if (!tabs.length) return;
    const key = (event: globalThis.KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || (event.code !== "Backquote" && event.key !== "`")) return;
      event.preventDefault();
      state.toggleOpen();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [tabs.length, state.toggleOpen]);

  if (!tabs.length) return null;
  if (!state.open) return <OpenToggle onOpen={() => state.setOpen(true)} />;
  return (
    <section ref={panel} aria-label="Bottom panel" style={state.maximised ? undefined : { height }}
      className={state.maximised
        ? "absolute inset-0 z-40 flex min-h-0 flex-col border-t border-[var(--v2-edge)] bg-[var(--v2-panel)]"
        : "relative flex shrink-0 flex-col border-t border-[var(--v2-edge)] bg-[var(--v2-panel)]"}>
      {!state.maximised && <ResizeHandle height={height} columnHeight={columnHeight} onChange={state.setHeight} onCommit={state.commitHeight} />}
      <Header tabs={tabs} selected={selected} maximised={state.maximised} onTab={state.setActiveTab}
        onMaximise={state.toggleMaximised} onClose={() => state.setOpen(false)} />
      <div role="tabpanel" id={`bottom-panel-${selected.id}`} aria-labelledby={`bottom-panel-tab-${selected.id}`}
        className="min-h-0 flex-1 overflow-auto">
        {selected.body}
      </div>
    </section>
  );
}

function OpenToggle({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex shrink-0 justify-end border-t border-[var(--v2-edge)] bg-[var(--v2-panel)] px-2 py-1">
      <button type="button" aria-label="Open bottom panel" title="Open bottom panel (Ctrl+`)" onClick={onOpen}
        className="v2-hover inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-muted)]">
        <PanelBottomOpen size={14} aria-hidden />
      </button>
    </div>
  );
}

function Header({ tabs, selected, maximised, onTab, onMaximise, onClose }: {
  tabs: PanelTab[]; selected: PanelTab; maximised: boolean;
  onTab: (tab: BottomPanelTab) => void; onMaximise: () => void; onClose: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-[var(--v2-edge)] pl-2 pr-1">
      <div role="tablist" aria-label="Bottom panel tabs" className="flex min-w-0 flex-1 items-center gap-1">
        {tabs.map(tab => (
          <button key={tab.id} type="button" role="tab" id={`bottom-panel-tab-${tab.id}`} aria-selected={selected.id === tab.id}
            aria-controls={`bottom-panel-${tab.id}`} onClick={() => onTab(tab.id)}
            className={`rounded-md px-2.5 py-1 text-[11.5px] ${selected.id === tab.id ? "bg-[var(--v2-track)] text-[var(--v2-text)]" : "v2-hover text-[var(--v2-muted)]"}`}>
            {tab.label}
          </button>
        ))}
      </div>
      <button type="button" aria-label={maximised ? "Restore bottom panel" : "Maximise bottom panel"}
        title={maximised ? "Restore bottom panel" : "Maximise bottom panel"} onClick={onMaximise}
        className="v2-hover inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-muted)]">
        {maximised ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
      </button>
      <button type="button" aria-label="Close bottom panel" title="Close bottom panel (Ctrl+`)" onClick={onClose}
        className="v2-hover inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-muted)]">
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
