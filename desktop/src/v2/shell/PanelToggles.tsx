// #14512: the top bar's panel cluster, docs/design/v2/PanelToggles.dc.html §C: [left][bottom][right]
// in the order the panels sit, next to the bell and avatar. It drives whatever the current screen
// registered; a screen with no such panel gets a disabled toggle whose tooltip says so.
import { PanelToggle } from "../ui/PanelToggle";
import { togglePanel, usePanelSlots, type PanelSide } from "./panelSlots";

// The tooltip names the action and its key: "Hide source control ⌘B", "Show chat ⌥⌘B".
type PanelMeta = { noun: string; key: string; gone: string };
const PANELS = {
  left: { noun: "source control", key: "⌘B", gone: "No source control column on this screen" },
  bottom: { noun: "the bottom panel", key: "⌘J", gone: "No bottom panel on this screen" },
  right: { noun: "chat", key: "⌥⌘B", gone: "No chat column on this screen" },
} satisfies Record<PanelSide, PanelMeta>;

const SIDES: readonly PanelSide[] = ["left", "bottom", "right"];

export function PanelToggles() {
  const slots = usePanelSlots();
  return (
    <div role="group" aria-label="Panel toggles" className="flex items-center gap-[2px] rounded-md border border-[var(--v2-edge)] bg-[var(--v2-chrome)] p-[2px]">
      {SIDES.map(side => {
        const slot = slots[side];
        const panel = PANELS[side];
        return (
          <PanelToggle key={side} side={side} open={slot?.open ?? false} disabled={!slot}
            tooltip={slot ? `${slot.open ? "Hide" : "Show"} ${panel.noun} ${panel.key}` : panel.gone}
            onToggle={() => { togglePanel(side); }} />
        );
      })}
    </div>
  );
}
