// Assistant replies arrive as markdown text; the old renderer showed the literal "**" and "- "
// markup, so long orchestrator replies were read in the terminal instead. This renders the subset
// that makes a chat reply readable: paragraphs, bullet and numbered lists, bold/italic, inline and
// fenced code, external links (opened by the shell opener, never in the webview), headings demoted
// to a bold line, and tables as a monospace block.
//
// Hand-rolled on purpose: react-markdown is not a dependency, and adding one would churn the shared
// pnpm lockfile under concurrent seats. The scope is deliberately smaller than CommonMark — no
// images, no raw-HTML passthrough (every token becomes a React element, so nothing can inject a
// tag), no footnotes. The parser is fault-tolerant: a reply mid-stream (unclosed fence or link) is
// rendered as text rather than swallowed, because the watcher appends rows as a turn runs.
import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

// ---- inline ------------------------------------------------------------------
type InlineNode =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "strong"; c: InlineNode[] }
  | { t: "em"; c: InlineNode[] }
  | { t: "a"; href: string; c: InlineNode[] };

/** Split one text run into inline tokens. `*`/`**` mark italic/bold; backticks are code; a
 *  `[label](http(s)://…)` link opens externally. A marker with no closer is left as text (streaming
 *  replies are frequently mid-token). SAFETY: the only atoms emitted are text/code/strong/em and
 *  http(s)-only links — an image or a javascript: URL can never become an element here.
 */
function inline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // Image syntax is deliberately dropped (no <img> in a chat reply).
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
          const label = rest.slice(1, close);
          const href = rest.slice(close + 2, paren);
          if (/^https?:\/\//i.test(href)) {
            out.push({ t: "a", href, c: inline(label) });
            i += paren + 1;
            continue;
          }
        }
      }
    }
    if (rest.startsWith("**")) {
      const close = rest.indexOf("**", 2);
      if (close > -1) {
        out.push({ t: "strong", c: inline(rest.slice(2, close)) });
        i += close + 2;
        continue;
      }
    }
    if (rest.startsWith("*")) {
      const close = rest.indexOf("*", 1);
      if (close > -1 && rest[close + 1] !== "*") {
        out.push({ t: "em", c: inline(rest.slice(1, close)) });
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
    // Plain text up to the next token start. Never consume zero. A `![` must stop the run too, or
    // the `!` becomes text and the `[` is then read as a link — which turns image alt into a link.
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

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((n, k) => {
    switch (n.t) {
      case "code":
        return <code key={k}>{n.s}</code>;
      case "strong":
        return <strong key={k}>{renderInline(n.c)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.c)}</em>;
      case "a":
        return (
          <a
            key={k}
            href={n.href}
            onClick={(e) => { e.preventDefault(); void openUrl(n.href).catch(() => {}); }}
            className="text-tr-doing underline decoration-tr-doing/40 underline-offset-2 hover:decoration-tr-doing"
          >
            {renderInline(n.c)}
          </a>
        );
      default:
        return n.s;
    }
  });
}

const inlineText = (s: string): ReactNode => renderInline(inline(s));

// ---- block structure ---------------------------------------------------------
// A block is either an atomic renderable or a list (which nests). Lists are parsed recursively by
// indentation: a line deeper than its parent's marker opens a child list under the parent item.
type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; text: string }
  | { kind: "list"; ordered: boolean; items: ListItem[] };
type ListItem = { text: string; children: Block[] };

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|?\s*$/;
const TABLE_RE = /^\s*\|/;

function isListLine(l: string): boolean {
  return /^\s*([-*+]|\d+[.)])\s+/.test(l);
}

/** Recursive block parser over a line array. Returns the list of blocks that fit at the current
 *  indent, plus the consumed line count. Handles fences, headings, tables, lists and paragraphs;
 *  a blank line or a dedent terminates whatever is being parsed.
 */
function parseAt(lines: string[], start: number, indent = 0): { blocks: Block[]; next: number } {
  const blocks: Block[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }          // blank: paragraph separator
    // A dedent below the floor this parse started at ends it: deeper content under a list item must
    // not swallow the outer sibling that follows it as a paragraph.
    if (indent > 0) {
      const ws = /^\s*/.exec(line)?.[0].length ?? 0;
      if (ws < indent) break;
    }
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const fence = fm[1][0];
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const closer = new RegExp(`^\\s*${fence}{3,}`).test(lines[j]);
        if (closer) { j++; break; }
        body.push(lines[j]);
        j++;
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      i = j;
      continue;
    }
    const lm = LIST_RE.exec(line);
    if (lm && lm[1].length >= indent) {
      const ordered = /^\d/.test(lm[2]);
      const items: ListItem[] = [];
      let j = i;
      // Collect sibling items at the same indentation as this first line.
      const baseIndent = lm[1].length;
      while (j < lines.length) {
        const sl = lines[j];
        const sm = LIST_RE.exec(sl);
        if (!sm || sm[1].length < indent || sm[1].length !== baseIndent || !sl.trim()) {
          break;
        }
        const text = sm[3];
        const children: Block[] = [];
        // Nested content under this item = following lines indented deeper.
        const sub = parseNested(lines, j + 1, baseIndent);
        children.push(...sub.blocks);
        items.push({ text, children });
        j = sub.next;
        if (j < lines.length && !lines[j].trim()) break;   // blank ends the list
      }
      blocks.push({ kind: "list", ordered, items });
      i = j;
      continue;
    }
    const hm = HEADING_RE.exec(line);
    if (hm) { blocks.push({ kind: "h", text: hm[1] }); i++; continue; }
    if (TABLE_RE.test(line)) {
      // A table needs a separator row after the header; otherwise a lone "| word" is prose.
      if (lines[i + 1] && TABLE_RE.test(lines[i + 1]) && TABLE_SEP_RE.test(lines[i + 1])) {
        const rows: string[] = [];
        let j = i;
        while (j < lines.length && TABLE_RE.test(lines[j])) {
          const cell = lines[j].trim().replace(/^\||\|$/g, "").trim();
          if (!TABLE_SEP_RE.test(lines[j])) rows.push(cell);
          j++;
        }
        blocks.push({ kind: "table", text: rows.join("\n") });
        i = j;
        continue;
      }
    }
    // Paragraph: consecutive non-structural lines joined into one run.
    const para: string[] = [line.trim()];
    let j = i + 1;
    while (
      j < lines.length && lines[j].trim()
      && !FENCE_RE.test(lines[j]) && !isListLine(lines[j])
      && !HEADING_RE.test(lines[j]) && !(TABLE_RE.test(lines[j]) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]))
    ) {
      para.push(lines[j].trim());
      j++;
    }
    blocks.push({ kind: "p", text: para.join(" ") });
    i = j;
  }
  return { blocks, next: i };
}

/** Parse the deeper-indented content that hangs under one list item. */
function parseNested(lines: string[], start: number, parentIndent: number): { blocks: Block[]; next: number } {
  const blocks: Block[] = [];
  let i = start;
  // Skip a blank line that may separate the item from its children.
  while (i < lines.length && !lines[i].trim()) i++;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    const lm = LIST_RE.exec(line);
    if (lm && lm[1].length > parentIndent) {
      const sub = parseAt(lines, i, lm[1].length);
      // parseAt already handles list runs at their own indent — but only if it starts exactly
      // there, so pass it through unchanged.
      blocks.push(...sub.blocks);
      i = sub.next;
      continue;
    }
    const hm = HEADING_RE.exec(line);
    if (hm && /^\s/.test(line)) { blocks.push({ kind: "h", text: hm[1] }); i++; continue; }
    break;
  }
  return { blocks, next: i };
}

function parseBlocks(text: string): Block[] {
  return parseAt(text.replace(/\r/g, "").split("\n"), 0).blocks;
}

/** A chunk of assistant text rendered as markdown. Never touches dangerouslySetInnerHTML — every
 *  construct maps to React elements, so raw HTML in a reply stays visible as literal text. */
export function MarkdownText({ text }: { text: string }) {
  return <div className="space-y-1.5">{parseBlocks(text).map(renderBlock)}</div>;
}

function renderBlock(b: Block, k: number): ReactNode {
  switch (b.kind) {
    case "p":
      return <p key={k}>{inlineText(b.text)}</p>;
    case "h":
      return <p key={k} className="font-semibold">{inlineText(b.text)}</p>;
    case "code":
      return (
        <pre key={k} className="tr-mono overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-black/20 px-2.5 py-2 leading-relaxed">
          {b.text}
        </pre>
      );
    case "table":
      return (
        <pre key={k} className="tr-mono overflow-x-auto whitespace-pre rounded-md bg-black/20 px-2.5 py-2 leading-relaxed text-tr-muted">
          {b.text}
        </pre>
      );
    case "list":
      return b.ordered ? (
        <ol key={k} className="list-decimal space-y-0.5 pl-5">{b.items.map(renderItem)}</ol>
      ) : (
        <ul key={k} className="list-disc space-y-0.5 pl-5">{b.items.map(renderItem)}</ul>
      );
  }
}

function renderItem(item: ListItem, k: number): ReactNode {
  return (
    <li key={k}>
      {inlineText(item.text)}
      {item.children.length > 0 && <div className="mt-0.5">{item.children.map(renderBlock)}</div>}
    </li>
  );
}
