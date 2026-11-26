// Small pieces the transcript shares (#14327): a copy button that shows a check for a moment, and a
// scroll box that fades its bottom edge while more is hidden below.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "../ui/IconButton";

export const COPIED_MS = 1200;

/** `copied` is true for 1.2s after a copy the clipboard accepted. */
export type Copier = { copied: boolean; copy: (text: string) => void };

export function useCopied(): Copier {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    }).catch(() => {});
  }, []);
  return { copied, copy };
}

export function CopyButton({ text, label, title, size, iconSize = 14, className = "" }: {
  text: string; label: string; title: string; size: number; iconSize?: number; className?: string;
}) {
  const { copied, copy } = useCopied();
  return (
    <IconButton label={copied ? "Copied" : label} title={copied ? "Copied" : title} size={size} className={className}
      data-copied={copied || undefined} onClick={() => copy(text)}>
      {copied
        ? <Check size={iconSize} aria-hidden className="text-[var(--v2-ok)]" />
        : <Copy size={iconSize} aria-hidden />}
    </IconButton>
  );
}

const FADE = "linear-gradient(to bottom, var(--v2-knob) calc(100% - 28px), transparent)";

/** Scrolls past `max` px and fades the bottom edge while content is hidden below it. */
export function FadeBox({ max, className = "", children }: { max: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setFade(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);
  useLayoutEffect(measure);
  return (
    <div ref={ref} data-fade={fade || undefined} onScroll={measure} className={`overflow-y-auto ${className}`}
      style={{ maxHeight: max, maskImage: fade ? FADE : undefined, WebkitMaskImage: fade ? FADE : undefined }}>
      {children}
    </div>
  );
}
