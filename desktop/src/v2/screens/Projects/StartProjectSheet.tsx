// The classic "Start a project" sheet, seated over the 2.0 shell: Escape closes, Tab stays inside,
// focus returns to where it was (#13984). The sheet itself is imported, never forked.
import { useEffect, useRef } from "react";
import { GenesisSheet, type GenesisSheetDeps } from "../../../features/genesis/GenesisSheet";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function StartProjectSheet({ devRoot, deps, onClose, onMade, onCreated }: {
  devRoot: string;
  deps: GenesisSheetDeps;
  onClose: () => void;
  onMade: (project: string) => void;
  onCreated: (project: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => before?.focus();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!ref.current?.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  };
  return (
    <div ref={ref} className="v2-genesis" onKeyDown={onKeyDown}>
      <GenesisSheet devRoot={devRoot} deps={deps} onClose={onClose} onMade={onMade} onCreated={onCreated} />
    </div>
  );
}
