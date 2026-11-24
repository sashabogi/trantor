// Extensions and tools screen (#13993): Open VSX browse is live; installs wait on the extension-host spike (#13985).
import { useState } from "react";
import { NotWired, type ScreenProps } from "../..";
import { Detail } from "./Detail";
import { useOpenVsxSearch } from "./hooks";
import type { Ext, SortKey } from "./openvsx";
import { Rail, useProviders, type Category } from "./Rail";
import { Results } from "./Results";

const NOT_WIRED = {
  mcp: { title: "Agent tools (MCP)", line: "The installed MCP servers and the registry are not readable from the hub yet." },
  skills: { title: "Skills", line: "The installed skills are not readable from the hub yet." },
  plugins: { title: "Plugins", line: "The installed plugins are not readable from the hub yet." },
  providers: { title: "Model providers", line: "Connected providers show in the Installed list; adding one is not wired yet." },
} as const satisfies Record<"mcp" | "skills" | "plugins" | "providers", { title: string; line: string }>;

export function ExtensionsScreen({ client }: ScreenProps) {
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("relevance");
  const [picked, setPicked] = useState<Ext | null>(null);
  const editorLive = category === "all" || category === "editor";
  const search = useOpenVsxSearch(query, sort, editorLive);
  const providers = useProviders(client);
  const total = search.status === "ready" && query.trim() === "" ? search.data.total : null;
  const selected = picked && search.status === "ready" && search.data.items.some(e => e.id === picked.id) ? picked : null;
  return (
    <div className="flex h-full min-h-0 bg-[var(--v2-bg)]">
      <Rail category={category} onCategory={setCategory} openVsxTotal={total} providers={providers} />
      {editorLive ? (
        <>
          <Results query={query} onQuery={setQuery} sort={sort} onSort={setSort} state={search} selectedId={selected?.id ?? null} onSelect={setPicked} />
          <Detail client={client} ext={selected} />
        </>
      ) : <NotWired {...NOT_WIRED[category]} />}
    </div>
  );
}
