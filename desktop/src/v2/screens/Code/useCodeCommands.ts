// The Code screen's commands, registered while it is mounted: new terminal, search in files, fetch.
import { useRegisterCommands } from "../../shell/commands";
import { sendBottomPanel } from "../../ui/BottomPanel/state";
import { shellStore } from "../../ui/BottomPanel/useShells";
import { scopeFetch } from "./scopeGitApi";

type CodeCommandDeps = {
  project: string;
  scope: string | null;
  refresh: () => void;
  onError: (message: string) => void;
  /** Shows the Search view in the sidebar. */
  showSearch: () => void;
};

function focusSearchInput() {
  const input = document.querySelector<HTMLInputElement>("#v2-text-search, #v2-file-search");
  input?.focus();
  input?.select();
}

export function useCodeCommands({ project, scope, refresh, onError, showSearch }: CodeCommandDeps) {
  useRegisterCommands([
    { id: "terminal.new", title: "New terminal", group: "Terminal", run: () => { void shellStore.open(project); sendBottomPanel("show-terminal"); } },
    { id: "search.inFiles", title: "Focus search in files", group: "Search", run: () => { showSearch(); setTimeout(focusSearchInput, 0); } },
    { id: "git.fetch", title: "Fetch from origin", group: "Git",
      run: () => { scopeFetch(project, scope).then(refresh).catch(e => onError(e instanceof Error ? e.message : String(e))); } },
  ]);
}
