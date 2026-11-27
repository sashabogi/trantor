// The 2.0 markdown renderer (#14327): headings, quotes, lists, real tables, code blocks with a copy
// button, inline code and links. Hand-rolled like the classic one to keep react-markdown out of the
// lockfile, and as safe: no images, no raw HTML, nesting capped. Text and inline code go through
// linkify, so a path, commit, card or URL becomes a link once it is known to be real.
import { memo, type ReactNode } from "react";
import type { Link } from "../../shared/linkify";
import { CopyButton, FadeBox } from "./bits";
import { LinkAnchor, Linked } from "./Linked";

// ---- inline ------------------------------------------------------------------
type InlineNode =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "strong"; c: InlineNode[] }
  | { t: "em"; c: InlineNode[] }
  | { t: "a"; href: string; c: InlineNode[] };

// A pathological reply (dozens of unclosed `*`, `**` or `[` openers) recurses once per nesting level;
// past this depth the rest renders as plain text instead of walking the stack (#6113).
const INLINE_MAX_DEPTH = 16;
const QUOTE_MAX_DEPTH = 6;

/** Split one text run into inline tokens. An unclosed marker renders as text, since streaming is
 *  often mid-token. SAFETY: only text, code, strong, em and http(s) links can come out. */
export function inline(text: string, depth = 0): InlineNode[] {
  if (depth >= INLINE_MAX_DEPTH) return [{ t: "text", s: text }];
  const out: InlineNode[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("![")) {
      const close = rest.indexOf("]");
      const paren = close > -1 ? rest.indexOf(")", close) : -1;
      if (paren > -1) { i += paren + 1; continue; }
    }
    if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close > 0 && rest[close + 1] === "(") {
        const paren = rest.indexOf(")", close + 2);
        if (paren > -1) {
          const href = rest.slice(close + 2, paren);
          if (/^https?:\/\//i.test(href)) {
            out.push({ t: "a", href, c: inline(rest.slice(1, close), depth + 1) });
            i += paren + 1;
            continue;
          }
        }
      }
    }
    if (rest.startsWith("**")) {
      const close = rest.indexOf("**", 2);
      if (close > -1) {
        out.push({ t: "strong", c: inline(rest.slice(2, close), depth + 1) });
        i += close + 2;
        continue;
      }
    }
    if (rest.startsWith("*")) {
      const close = rest.indexOf("*", 1);
      if (close > -1 && rest[close + 1] !== "*") {
        out.push({ t: "em", c: inline(rest.slice(1, close), depth + 1) });
        i += close + 1;
        continue;
      }
    }
    if (rest.startsWith("`")) {
      const close = rest.indexOf("`", 1);
      if (close > -1) {
        out.push({ t: "code", s: rest.slice(1, close) });
        i += close + 1;
        continue;
      }
    }
    let end = rest.length;
    for (let j = 1; j < rest.length; j++) {
      const c = rest[j];
      if (c === "*" || c === "`" || c === "[" || (c === "!" && rest[j + 1] === "[")) { end = j; break; }
    }
    out.push({ t: "text", s: rest.slice(0, end) });
    i += end;
  }
  return out;
}

const CODE_CHIP = "v2-mono rounded-sm bg-[var(--v2-sunken)] px-1 py-px text-[.92em] text-[var(--v2-text-2)]";

/** `linkify` is off inside a link's own label, where a nested anchor would be invalid. */
function renderInline(nodes: InlineNode[], linkify = true): ReactNode {
  return nodes.map((n, k) => {
    switch (n.t) {
      case "code":
        return <code key={k} className={CODE_CHIP}>{linkify ? <Linked text={n.s} /> : n.s}</code>;
      case "strong":
        return <strong key={k} className="font-semibold">{renderInline(n.c, linkify)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.c, linkify)}</em>;
      case "a": {
        const link: Link = { kind: "url", href: n.href, label: n.href, pending: false };
        return <LinkAnchor key={k} link={link}>{renderInline(n.c, false)}</LinkAnchor>;
      }
      default:
        return linkify ? <Linked key={k} text={n.s} /> : n.s;
    }
  });
}

const inlineText = (s: string): ReactNode => renderInline(inline(s));

// ---- blocks ------------------------------------------------------------------
type Align = "left" | "right" | "center" | null;
type MdBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { kind: "quote"; blocks: MdBlock[] }
  | { kind: "hr" }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] };
type ListItem = { text: string; children: MdBlock[] };
type Cursor = { blocks: MdBlock[]; next: number };

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^\s*(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const isListLine = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
const isSeparator = (l: string | undefined) => l !== undefined && l.includes("|") && SEPARATOR_RE.test(l);
const startsTable = (lines: string[], i: number) => lines[i].includes("|") && isSeparator(lines[i + 1]);

/** A table row's cells: split on pipes that are not escaped or inside backticks. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let ticks = false;
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && body[i + 1] === "|") { cell += "|"; i++; continue; }
    if (c === "`") ticks = !ticks;
    if (c === "|" && !ticks) { cells.push(cell.trim()); cell = ""; continue; }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

function startsBlock(lines: string[], j: number): boolean {
  const l = lines[j];
  return FENCE_RE.test(l) || isListLine(l) || HEADING_RE.test(l) || QUOTE_RE.test(l) || HR_RE.test(l) || startsTable(lines, j);
}

function parseAt(lines: string[], start: number, indent = 0, depth = 0): Cursor {
  const blocks: MdBlock[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (indent > 0 && (/^\s*/.exec(line)?.[0].length ?? 0) < indent) break;
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const body: string[] = [];
      let j = i + 1;
      const closer = new RegExp(`^\\s*${fm[1][0]}{3,}\\s*$`);
      while (j < lines.length) {
        if (closer.test(lines[j])) { j++; break; }
        body.push(lines[j]);
        j++;
      }
      blocks.push({ kind: "code", lang: fm[2], text: body.join("\n") });
      i = j;
      continue;
    }
    if (HR_RE.test(line)) { blocks.push({ kind: "hr" }); i++; continue; }
    const lm = LIST_RE.exec(line);
    if (lm && lm[1].length >= indent) {
      const ordered = /^\d/.test(lm[2]);
      const items: ListItem[] = [];
      const baseIndent = lm[1].length;
      let j = i;
      while (j < lines.length) {
        const sm = LIST_RE.exec(lines[j]);
        if (!sm || sm[1].length < indent || sm[1].length !== baseIndent) break;
        const sub = parseNested(lines, j + 1, baseIndent);
        items.push({ text: sm[3], children: sub.blocks });
        j = sub.next;
        // A blank line ends the list unless the next item is a sibling of the same kind (a loose list).
        if (j < lines.length && !lines[j].trim()) {
          let k = j;
          while (k < lines.length && !lines[k].trim()) k++;
          const next = k < lines.length ? LIST_RE.exec(lines[k]) : null;
          if (!next || next[1].length !== baseIndent || /^\d/.test(next[2]) !== ordered) break;
          j = k;
        }
      }
      blocks.push({ kind: "list", ordered, start: ordered ? parseInt(lm[2], 10) : 1, items });
      i = j;
      continue;
    }
    const hm = HEADING_RE.exec(line);
    if (hm) { blocks.push({ kind: "h", level: hm[1].length, text: hm[2].replace(/\s+#+\s*$/, "") }); i++; continue; }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      let j = i;
      while (j < lines.length && QUOTE_RE.test(lines[j])) { inner.push(QUOTE_RE.exec(lines[j])?.[1] ?? ""); j++; }
      blocks.push(depth < QUOTE_MAX_DEPTH
        ? { kind: "quote", blocks: parseAt(inner, 0, 0, depth + 1).blocks }
        : { kind: "p", text: inner.join(" ") });
      i = j;
      continue;
    }
    if (startsTable(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) { rows.push(splitRow(lines[j])); j++; }
      blocks.push({ kind: "table", head, align, rows });
      i = j;
      continue;
    }
    const para: string[] = [line.trim()];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !startsBlock(lines, j)) { para.push(lines[j].trim()); j++; }
    blocks.push({ kind: "p", text: para.join(" ") });
    i = j;
  }
  return { blocks, next: i };
}

/** The deeper-indented content that hangs under one list item. */
function parseNested(lines: string[], start: number, parentIndent: number): Cursor {
  const blocks: MdBlock[] = [];
  let i = start;
  while (i < lines.length && !lines[i].trim()) i++;
  // Blank lines only belong to the item when something deeper follows them.
  const first = i < lines.length ? LIST_RE.exec(lines[i]) : null;
  if (!first || first[1].length <= parentIndent) return { blocks, next: start };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    const lm = LIST_RE.exec(line);
    if (lm && lm[1].length > parentIndent) {
      const sub = parseAt(lines, i, lm[1].length);
      blocks.push(...sub.blocks);
      i = sub.next;
      continue;
    }
    break;
  }
  return { blocks, next: i };
}

export function parseBlocks(text: string): MdBlock[] {
  return parseAt(text.replace(/\r/g, "").split("\n"), 0).blocks;
}

// ---- render ------------------------------------------------------------------
const NUMERIC = /^[-+]?[$€£]?[\d,]+(?:\.\d+)?%?$/;

// a column whose every cell fits this many characters is a label column: it never wraps
export const SHORT_CELL = 18;

function Table({ block }: { block: Extract<MdBlock, { kind: "table" }> }) {
  const numeric = block.head.map((_, c) => block.rows.length > 0 && block.rows.every(r => NUMERIC.test(r[c] ?? "")));
  // the chat column is narrow and the markdown root wraps anywhere, which made each cell's
  // min width one letter ("m/e/di/u/m"). Words stay whole here; label columns never wrap, prose
  // columns keep a readable floor, and a table wider than the column scrolls instead of collapsing.
  const short = block.head.map((h, c) => [h, ...block.rows.map(r => r[c] ?? "")].every(t => t.trim().length <= SHORT_CELL));
  const fit = (c: number) => (short[c] ? "whitespace-nowrap" : "min-w-[16ch]");
  const side = (c: number): "left" | "right" | "center" => block.align[c] ?? (numeric[c] ? "right" : "left");
  const alignClass = { left: "text-left", right: "text-right", center: "text-center" } as const;
  return (
    <div className="my-[.7em] overflow-x-auto rounded-md border border-[var(--v2-edge)]">
      <table className="w-full border-collapse text-v2-body leading-normal [overflow-wrap:normal] [word-break:normal]">
        <thead>
          <tr className="bg-[var(--v2-panel-2)]">
            {block.head.map((h, c) => (
              <th key={c} scope="col" className={`px-2.5 py-1.5 align-bottom text-v2-small font-semibold text-[var(--v2-muted)] ${alignClass[side(c)]} ${fit(c)}`}>{inlineText(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-t border-[var(--v2-edge-soft)]">
              {block.head.map((_, c) => (
                <td key={c} data-numeric={numeric[c] || undefined}
                  className={`px-2.5 py-1.5 align-top ${alignClass[side(c)]} ${fit(c)} ${numeric[c] ? "v2-mono" : ""} ${c === 0 ? "font-medium" : ""}`}>
                  {inlineText(row[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  return (
    <div data-code-block className="my-[.7em] overflow-hidden rounded-md border border-[var(--v2-edge)]">
      <div className="flex h-6 items-center bg-[var(--v2-panel-2)] pl-2.5 pr-1">
        <span className="text-v2-micro text-[var(--v2-muted)]">{lang || "text"}</span>
        <span className="flex-1" />
        <CopyButton text={text} label="Copy code" title="Copy code" size={20} iconSize={12} />
      </div>
      <FadeBox max={360} className="bg-[var(--v2-sunken)]">
        <pre className="v2-mono m-0 overflow-x-auto px-2.5 py-2 text-v2-body leading-[1.55] text-[var(--v2-text-2)]">{text}</pre>
      </FadeBox>
    </div>
  );
}

function renderBlock(b: MdBlock, k: number): ReactNode {
  switch (b.kind) {
    case "p":
      return <p key={k} className="my-[.7em] first:mt-0 last:mb-0">{inlineText(b.text)}</p>;
    case "h":
      return (
        <p key={k} role="heading" aria-level={b.level} className={`mb-[.4em] mt-[.9em] font-semibold first:mt-0 ${b.level <= 2 ? "text-v2-title" : "text-v2-base"}`}>
          {inlineText(b.text)}
        </p>
      );
    case "quote":
      return <blockquote key={k} className="my-[.7em] border-l-2 border-[var(--v2-accent-edge)] pl-3 text-[var(--v2-muted)]">{b.blocks.map(renderBlock)}</blockquote>;
    case "hr":
      return <hr key={k} className="my-[.9em] border-0 border-t border-[var(--v2-edge-soft)]" />;
    case "code":
      return <CodeBlock key={k} lang={b.lang} text={b.text} />;
    case "table":
      return <Table key={k} block={b} />;
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag key={k} start={b.ordered ? b.start : undefined}
          className={`my-[.7em] flex flex-col gap-[.2em] pl-[1.4em] first:mt-0 last:mb-0 ${b.ordered ? "list-decimal" : "list-disc"}`}>
          {b.items.map((item, i) => (
            <li key={i}>
              {inlineText(item.text)}
              {item.children.length > 0 && <div className="mt-[.2em]">{item.children.map(renderBlock)}</div>}
            </li>
          ))}
        </Tag>
      );
    }
  }
}

/** A chunk of assistant text as markdown. Never touches dangerouslySetInnerHTML. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div data-markdown className="text-v2-base leading-[1.65] [overflow-wrap:anywhere]">{parseBlocks(text).map(renderBlock)}</div>;
});
