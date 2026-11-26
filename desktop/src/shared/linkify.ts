// LINKIFY (#14327): turn plain text into text and links. URLs and card ids are certain; paths and
// commit hashes are only candidates until the project's checkout confirms them, so a word that
// merely looks like a file or a hash never becomes a dead link.
import { invoke } from "@tauri-apps/api/core";

export type LinkKind = "url" | "path" | "card" | "commit";

export type Link = {
  kind: LinkKind;
  /** url: the address. path: the path as written, without a line suffix. card: the digits. commit: the hash. */
  href: string;
  /** the text as written, line suffix included */
  label: string;
  line?: number;
  col?: number;
  /** `#L12-L20` and `:12-20` style ranges end here */
  endLine?: number;
  /** true for paths and commits until `confirm` has checked them */
  pending: boolean;
};

export type Segment = { text: string } | { link: Link };

const SEG = String.raw`[\w@+.-]+`;
const FRONT = String.raw`(?<![\w@/~:.\\-])`;
const URL_RE = String.raw`https?:\/\/[^\s<>"'\x60]+`;
const ABS = String.raw`(?:~\/|\/)(?:${SEG}\/)*${SEG}`;
const REL = String.raw`(?:\.{1,2}\/)+${SEG}(?:\/${SEG})*|${SEG}(?:\/${SEG})+`;
const BARE = String.raw`[\w-][\w+-]*(?:\.[\w+-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}`;
const SUFFIX = String.raw`(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?`;
const PATH = String.raw`${FRONT}(?:${ABS}|${REL}|${BARE})${SUFFIX}(?![\w/])`;
const CARD = String.raw`(?<![\w#&/.-])#(?<card>\d{3,})(?![\w])`;
const SHA = String.raw`(?<![\w/.#@-])(?<sha>[0-9a-f]{7,40})(?![\w-])`;
const TOKEN = new RegExp(`(?<url>${URL_RE})|(?<path>${PATH})|${CARD}|${SHA}`, "g");

const PATH_SUFFIX = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:-L?(\d+))?)$/;
const TRAILING_URL = /[.,;:!?'"*]+$/;
/** More candidates than this in one text are left as plain text: a pasted wall is not a reply. */
const MAX_LINKS = 60;

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** A URL without the punctuation that belongs to the sentence or the markdown around it. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING_URL, "");
    for (const [close, open] of [[")", "("], ["]", "["], ["}", "{"]] as const) {
      if (url.endsWith(close) && count(url, close) > count(url, open)) url = url.slice(0, -1);
    }
    if (url === before) return url;
  }
}

function pathLink(raw: string): Link | null {
  let text = raw;
  let line: number | undefined;
  let col: number | undefined;
  let endLine: number | undefined;
  const m = PATH_SUFFIX.exec(text);
  if (m) {
    text = text.slice(0, m.index);
    line = Number(m[1] ?? m[3]);
    col = m[2] ? Number(m[2]) : undefined;
    endLine = m[4] ? Number(m[4]) : undefined;
  } else {
    text = text.replace(/\.+$/, "");
  }
  if (!text || text === "~" || !/[A-Za-z]/.test(text)) return null;
  return { kind: "path", href: text, label: m ? raw : text, line, col, endLine, pending: true };
}

const isSha = (s: string) => /[a-f]/.test(s) && /\d/.test(s);

/** Split text into plain pieces and links. Pure: paths and commits come back `pending`. */
export function tokenize(input: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  let links = 0;
  const pushText = (to: number) => {
    if (to <= last) return;
    const text = input.slice(last, to);
    const prev = out[out.length - 1];
    if (prev && "text" in prev) prev.text += text;
    else out.push({ text });
    last = to;
  };
  for (const m of input.matchAll(TOKEN)) {
    if (links >= MAX_LINKS) break;
    const at = m.index;
    const g = m.groups ?? {};
    let link: Link | null = null;
    let length = m[0].length;
    if (g.url) {
      const url = trimUrl(g.url);
      length = url.length;
      link = url.length > "https://".length ? { kind: "url", href: url, label: url, pending: false } : null;
    } else if (g.path) {
      link = pathLink(g.path);
      if (link) length = link.label.length;
    } else if (g.card) {
      link = { kind: "card", href: g.card, label: `#${g.card}`, pending: false };
    } else if (g.sha && isSha(g.sha)) {
      link = { kind: "commit", href: g.sha, label: g.sha, pending: true };
    }
    if (!link) continue;
    pushText(at);
    out.push({ link });
    links++;
    last = at + length;
  }
  pushText(input.length);
  return out;
}

/** The existence checks, injected so tests and previews never touch the machine. */
export type LinkApi = {
  pathsExist: (project: string, paths: string[]) => Promise<boolean[]>;
  commitsExist: (project: string, shas: string[]) => Promise<boolean[]>;
};

export const tauriLinkApi: LinkApi = {
  pathsExist: (project, paths) => invoke<boolean[]>("paths_exist", { project, paths }),
  commitsExist: (project, shas) => invoke<boolean[]>("commits_exist", { project, shas }),
};

/** A miss is asked again after this long: a file or commit made since must become a link. */
const MISS_TTL_MS = 15_000;

type Verdict = { exists: boolean; at: number };

export type LinkResolver = {
  /** Confirms the pending links in one batch per kind; ones that do not exist go back to text. */
  confirm: (segments: Segment[]) => Promise<Segment[]>;
};

/** A resolver with its own cache for one project. Hits are kept; misses expire. */
export function createLinkResolver(project: string, api: LinkApi, now: () => number = Date.now): LinkResolver {
  const paths = new Map<string, Verdict>();
  const commits = new Map<string, Verdict>();
  const fresh = (v: Verdict | undefined): v is Verdict => v !== undefined && (v.exists || now() - v.at < MISS_TTL_MS);

  async function fill(cache: Map<string, Verdict>, wanted: string[], ask: (names: string[]) => Promise<boolean[]>) {
    const unknown = [...new Set(wanted)].filter(name => !fresh(cache.get(name)));
    if (unknown.length === 0) return;
    const answers = await ask(unknown);
    unknown.forEach((name, i) => cache.set(name, { exists: answers[i] === true, at: now() }));
  }

  return {
    async confirm(segments) {
      const pending = segments.flatMap(s => ("link" in s && s.link.pending ? [s.link] : []));
      if (pending.length === 0) return segments;
      await Promise.all([
        fill(paths, pending.filter(l => l.kind === "path").map(l => l.href), names => api.pathsExist(project, names)),
        fill(commits, pending.filter(l => l.kind === "commit").map(l => l.href), names => api.commitsExist(project, names)),
      ]).catch(() => undefined);
      const out: Segment[] = [];
      const add = (seg: Segment) => {
        const prev = out[out.length - 1];
        if ("text" in seg && prev && "text" in prev) prev.text += seg.text;
        else out.push(seg);
      };
      for (const seg of segments) {
        if (!("link" in seg) || !seg.link.pending) { add(seg); continue; }
        const l = seg.link;
        const verdict = (l.kind === "path" ? paths : commits).get(l.href);
        if (verdict?.exists) add({ link: { ...l, pending: false } });
        else add({ text: l.label });
      }
      return out;
    },
  };
}

const resolvers = new Map<string, LinkResolver>();

/** The shared resolver for a project, backed by the app's own commands. */
export function linkResolverFor(project: string): LinkResolver {
  const known = resolvers.get(project);
  if (known) return known;
  const made = createLinkResolver(project, tauriLinkApi);
  resolvers.set(project, made);
  return made;
}
