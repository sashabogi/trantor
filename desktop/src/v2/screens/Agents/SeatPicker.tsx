// The Workspace strip's Add-a-seat menu, unchanged: one picker, shared by this screen's entry points (#14050).
import type { ReactNode } from "react";
import { PopMenu } from "../Workspace/PopMenu";
import type { Crew } from "../Workspace/useCrew";

export type PickerTrigger = (props: { onClick: () => void; "aria-haspopup": "menu"; "aria-expanded": boolean }, open: boolean) => ReactNode;

export function SeatPicker({ crew, trigger }: { crew: Crew; trigger: PickerTrigger }) {
  return (
    <PopMenu heading="Add a seat" empty={crew.unavailableReason?.() ?? "Reading installed agents"}
      items={crew.available.map(a => ({ id: a.id, label: a.label, sub: `starts ${a.launch}`, disabledReason: crew.busy ? "Another seat action is running" : null, onPick: () => void crew.start(a.id) }))}
      trigger={trigger} />
  );
}
