// Text that turns into links (#14327): URLs and card ids at once; paths and commits stay plain text
// in the same font until the checkout confirms them, so a link appearing never moves the line.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { tokenize, type Link, type Segment } from "../../shared/linkify";
import { useLinks } from "./LinkContext";

/** The hover text of a link: what a click will do. */
export function linkTitle(link: Link): string {
  if (link.kind === "url") return link.href;
  if (link.kind === "card") return `Open card #${link.href}`;
  if (link.kind === "commit") return `Open commit ${link.href.slice(0, 7)}`;
  return link.line ? `Open ${link.href} at line ${link.line}` : `Open ${link.href}`;
}

/** One link, in the link colour; underline on hover. */
export function LinkAnchor({ link, children, className = "" }: { link: Link; children?: ReactNode; className?: string }) {
  const { open } = useLinks();
  return (
    <a href={link.kind === "url" ? link.href : "#"} title={linkTitle(link)} data-link-kind={link.kind}
      onClick={e => { e.preventDefault(); open(link, { metaKey: e.metaKey }); }}
      className={`text-[var(--v2-link)] underline-offset-2 hover:underline ${className}`}>
      {children ?? link.label}
    </a>
  );
}

/** The text's segments with every pending link resolved or dropped back to text. */
export function useSegments(text: string): Segment[] {
  const { resolver } = useLinks();
  const first = useMemo(() => tokenize(text), [text]);
  const [confirmed, setConfirmed] = useState<{ from: Segment[]; to: Segment[] } | null>(null);
  useEffect(() => {
    if (!resolver || !first.some(s => "link" in s && s.link.pending)) return;
    let alive = true;
    void resolver.confirm(first).then(to => { if (alive) setConfirmed({ from: first, to }); }).catch(() => {});
    return () => { alive = false; };
  }, [resolver, first]);
  // A confirmation belongs to the exact tokens it was asked about; a newer text starts from plain.
  return confirmed?.from === first ? confirmed.to : first;
}

/** Plain text as written, with confirmed links as anchors; pending ones stay text. */
export function Linked({ text }: { text: string }) {
  const segments = useSegments(text);
  return (
    <>
      {segments.map((seg, i) => "text" in seg
        ? seg.text
        : seg.link.pending ? seg.link.label : <LinkAnchor key={i} link={seg.link} />)}
    </>
  );
}
