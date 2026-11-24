// Open VSX public API client for the Extensions screen (#13993). The app CSP allows https: in connect-src.
const BASE = "https://open-vsx.org/api";

export type SortKey = "relevance" | "downloadCount" | "timestamp" | "verified";

export type Ext = {
  id: string; namespace: string; name: string; displayName: string; description: string;
  version: string; downloads: number; rating: number | null; iconUrl: string | null; verified: boolean;
};

export type ExtDetail = {
  reviewCount: number | null; timestamp: string | null; license: string | null;
  repository: string | null; readmeUrl: string | null;
};

export type SearchResult = { total: number; items: Ext[] };

/** The slice of the Open VSX payload this screen reads; every field may be absent (#13993). */
export type RawExt = {
  namespace?: string; name?: string; displayName?: string; description?: string; version?: string;
  downloadCount?: number; averageRating?: number; reviewCount?: number; timestamp?: string; license?: string;
  repository?: string; verified?: boolean; namespaceAccess?: string;
  files?: { icon?: string; readme?: string };
};
export type RawSearch = { totalSize?: number; extensions?: RawExt[] };

const str = (v: string | undefined): string | null => (v ? v : null);
const num = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) ? v : null);

/** Open VSX marks a verified namespace owner with `verified` or namespaceAccess "restricted" (#13993). */
export function mapExtension(raw: RawExt | null): Ext | null {
  const namespace = str(raw?.namespace), name = str(raw?.name);
  if (!raw || !namespace || !name) return null;
  const rating = num(raw.averageRating);
  return {
    id: `${namespace}.${name}`, namespace, name,
    displayName: str(raw.displayName) ?? name,
    description: str(raw.description) ?? "",
    version: str(raw.version) ?? "",
    downloads: num(raw.downloadCount) ?? 0,
    rating: rating !== null && rating > 0 ? rating : null,
    iconUrl: str(raw.files?.icon),
    verified: raw.verified === true || raw.namespaceAccess === "restricted",
  };
}

export function mapSearch(body: RawSearch | null): SearchResult {
  if (!body || !Array.isArray(body.extensions)) throw new Error("Open VSX answered with an unexpected shape");
  const items = body.extensions.map(mapExtension).filter((e): e is Ext => e !== null);
  return { total: num(body.totalSize) ?? items.length, items };
}

export function mapDetail(body: RawExt | null): ExtDetail {
  return {
    reviewCount: num(body?.reviewCount), timestamp: str(body?.timestamp), license: str(body?.license),
    repository: str(body?.repository), readmeUrl: str(body?.files?.readme),
  };
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Open VSX answered ${res.status}`);
  return res.json();
}

const API_SORT = { relevance: "relevance", verified: "relevance", downloadCount: "downloadCount", timestamp: "timestamp" } as const;

export async function searchOpenVsx(query: string, sort: SortKey, signal: AbortSignal): Promise<SearchResult> {
  const q = new URLSearchParams({ query, size: "20", sortBy: API_SORT[sort] });
  const out = mapSearch(await getJson<RawSearch>(`${BASE}/-/search?${q}`, signal));
  return sort === "verified" ? { ...out, items: out.items.filter(e => e.verified) } : out;
}

export async function fetchDetail(e: Ext, signal: AbortSignal): Promise<ExtDetail> {
  return mapDetail(await getJson<RawExt>(`${BASE}/${encodeURIComponent(e.namespace)}/${encodeURIComponent(e.name)}`, signal));
}

/** README arrives as text; the screen renders it as plain text only, never as HTML (#13993). */
export async function fetchReadme(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`README answered ${res.status}`);
  return (await res.text()).slice(0, 1800);
}
