import { useActivePane } from "../useActivePane";
// Developer mode's bottom panel frame; terminal, output and problems bodies arrive as props (#14071).
// #14241: the top-edge handle is the shared Splitter, and the header tabs ride the shared Tabs bar.
// #14512: closed renders nothing — the top bar's bottom toggle (and Ctrl+`) brings it back.
import { useEffect, useRef, type ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useShellMode } from "../../shell/shellMode";
import { usePanelSlot } from "../../shell/panelSlots";
import { BOTTOM_PANEL_EVENT, MIN_HEIGHT, clampHeight, maxHeight, useBottomPanelState, type BottomPanelTab } from "./state";
import { Splitter } from "../Splitter";
import { Tabs } from "../Tabs";

type PanelTab = { id: BottomPanelTab; label: string; body: ReactNode };

export function BottomPanel({ terminal, output, problems }: { terminal?: ReactNode; output?: ReactNode; problems?: ReactNode }) {
  const pane = useActivePane();
  const mode = useShellMode();
  const state = useBottomPanelState(mode);
  const panel = useRef<HTMLDivElement | null>(null);
  const tabs = ([
    { id: "terminal", label: "Terminal", body: terminal },
    { id: "output", label: "Output", body: output },
    { id: "problems", label: "Problems", body: problems },
  ] satisfies PanelTab[]).filter(tab => tab.body !== undefined && tab.body !== null);
  // #14512: the shell's bottom toggle and ⌘J drive this panel through its slot.
  usePanelSlot("bottom", tabs.length ? { open: state.open, toggle: state.toggleOpen } : null);
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

  useEffect(() => {
    if (!tabs.length) return;
    const onAction = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      if (event.detail === "toggle") state.toggleOpen();
      else if (event.detail === "show-terminal") { state.setOpen(true); state.setActiveTab("terminal"); }
    };
    window.addEventListener(BOTTOM_PANEL_EVENT, onAction);
    return () => window.removeEventListener(BOTTOM_PANEL_EVENT, onAction);
  }, [tabs.length, state.toggleOpen, state.setOpen, state.setActiveTab]);

  if (!tabs.length) return null;
  if (!state.open) return null;
  return (
    // #14250: the panel is a pane in the column's 6px gap; the wrapper stays unclipped so the splitter strip lives in the gap.
    <div ref={panel} className={state.maximised ? "shrink-0" : "relative flex shrink-0 flex-col"}
      style={state.maximised ? undefined : { height }}>
      {!state.maximised && <Splitter orientation="rows" edge="top" label="Resize bottom panel"
        title="Drag to resize, or use the up and down arrow keys"
        value={height} min={MIN_HEIGHT} max={maxHeight(columnHeight())}
        onChange={state.setHeight} onCommit={state.commitHeight} />}
      <section {...pane} aria-label="Bottom panel" className={state.maximised
        ? "absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)]"
        : "flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)]"}>
        <Header tabs={tabs} selected={selected} maximised={state.maximised} onTab={state.setActiveTab}
          onMaximise={state.toggleMaximised} onClose={() => state.setOpen(false)} />
        <div role="tabpanel" id={`bottom-panel-${selected.id}`} aria-labelledby={`bottom-panel-tab-${selected.id}`}
          className="min-h-0 flex-1 overflow-auto">
          {selected.body}
        </div>
      </section>
    </div>
  );
}

function Header({ tabs, selected, maximised, onTab, onMaximise, onClose }: {
  tabs: PanelTab[]; selected: PanelTab; maximised: boolean;
  onTab: (tab: BottomPanelTab) => void; onMaximise: () => void; onClose: () => void;
}) {
  return (
    <Tabs label="Bottom panel tabs" pane="var(--v2-panel)" barClassName="h-9 pl-2 pr-1"
      tabs={tabs.map(tab => ({ id: tab.id, label: tab.label, buttonId: `bottom-panel-tab-${tab.id}`, controls: `bottom-panel-${tab.id}` }))}
      activeId={selected.id} onSelect={onTab}
      end={<>
        <button type="button" aria-label={maximised ? "Restore bottom panel" : "Maximise bottom panel"}
          title={maximised ? "Restore bottom panel" : "Maximise bottom panel"} onClick={onMaximise}
          className="v2-hover inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-muted)]">
          {maximised ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
        </button>
        <button type="button" aria-label="Close bottom panel" title="Close bottom panel (Ctrl+`)" onClick={onClose}
          className="v2-hover inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-muted)]">
          <X size={14} aria-hidden />
        </button>
      </>} />
  );
}
