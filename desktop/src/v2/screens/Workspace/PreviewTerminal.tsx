import { useMemo, type ComponentProps } from "react";
import { DEFAULT_TERMINAL_DEPS, TerminalPane, type TerminalDeps } from "../../../features/workspace/TerminalPane";
import { terminalBytes } from "../../../features/workspace/herdr";
import { previewScanner, previewStore, type PreviewStore } from "./previewStore";

export function previewTerminalDeps(project: string, agent: string, deps: TerminalDeps, store: PreviewStore = previewStore): TerminalDeps {
  return {
    ...deps,
    surfaceFor: async (p, a, machine) => {
      const location = await deps.surfaceFor(p, a, machine);
      if (!location.surface) store.end(project, agent);
      return location;
    },
    termAttach: (target, onBytes, machine) => {
      const decoder = new TextDecoder();
      const scan = previewScanner((url, tool) => store.detect(project, agent, agent, url, tool, machine ?? undefined));
      return deps.termAttach(target, bytes => {
        scan(decoder.decode(terminalBytes(bytes), { stream: true }));
        onBytes(bytes);
      }, machine);
    },
  };
}

export function PreviewTerminal({ deps = DEFAULT_TERMINAL_DEPS, ...props }: ComponentProps<typeof TerminalPane>) {
  const observed = useMemo(() => previewTerminalDeps(props.project, props.agent, deps), [props.project, props.agent, deps]);
  return <TerminalPane {...props} deps={observed} />;
}
