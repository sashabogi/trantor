// The two heavy panes the Workspace mounts, injectable so tests substitute faithful stand-ins (#13987).
import { createContext, useContext, type ComponentProps, type ComponentType } from "react";
import { TerminalPane } from "../../../features/workspace/TerminalPane";
import { PreviewTerminal } from "./PreviewTerminal";
import { RightPanel } from "./RightPanel";

export type WorkspacePanes = {
  TerminalPane: ComponentType<ComponentProps<typeof TerminalPane>>;
  RightPanel: ComponentType<ComponentProps<typeof RightPanel>>;
};

export const DEFAULT_PANES: WorkspacePanes = { TerminalPane: PreviewTerminal, RightPanel };

export const WorkspacePanesContext = createContext<WorkspacePanes>(DEFAULT_PANES);

export const usePanes = () => useContext(WorkspacePanesContext);
