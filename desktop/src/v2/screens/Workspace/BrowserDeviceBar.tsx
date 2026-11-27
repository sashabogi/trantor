// The device bar (artboard F2, #14516): the contract's presets, a custom size, rotate and Done.
// Emulation letterboxes the page at the device size — size and user agent only, because WebKit
// cannot fake touch or pixel density. Preset -> browser_emulate(device), Done -> browser_emulate(null).
import { useEffect, useState, type KeyboardEvent } from "react";
import { RefreshCw } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { DEVICE_PRESETS, type BrowserDevice } from "./browserModel";

const PILL = "v2-hover shrink-0 rounded-full border px-2.5 py-[3px] text-v2-body";
const PILL_ON = "border-[var(--v2-accent-edge)] bg-[var(--v2-accent-soft)] text-[var(--v2-text)]";
const PILL_OFF = "border-[var(--v2-edge-2)] bg-transparent text-[var(--v2-text-2)]";
const SIZE_INPUT = "v2-mono h-[22px] w-14 shrink-0 rounded-md border border-[var(--v2-edge-2)] bg-[var(--v2-side)] px-1.5 text-center text-v2-small text-[var(--v2-text-2)] outline-none";
const DONE = "v2-hover inline-flex h-[22px] shrink-0 items-center rounded-md border border-[var(--v2-edge-2)] bg-transparent px-2 text-v2-small font-medium text-[var(--v2-text)]";

/** A custom size is its own device: no preset name, no mobile user agent. */
const customDevice = (w: number, h: number): BrowserDevice => ({ name: "Custom", w, h, mobile: false });

export function BrowserDeviceBar({ device, onEmulate, onDone }: {
  /** The live emulation, from browser://state: a preset picked here, an agent's resize, a relaunch. */
  device: BrowserDevice | null;
  onEmulate: (device: BrowserDevice) => void;
  onDone: () => void;
}) {
  const [w, setW] = useState("");
  const [h, setH] = useState("");

  // Seed the size fields from the live device so the bar always shows what is in force.
  useEffect(() => {
    setW(device ? String(device.w) : "");
    setH(device ? String(device.h) : "");
  }, [device]);

  const applyCustom = (): void => {
    const cw = Number(w);
    const ch = Number(h);
    if (cw > 0 && ch > 0) onEmulate(customDevice(cw, ch));
  };
  const sizeKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") { e.preventDefault(); applyCustom(); }
  };
  const rotate = (): void => {
    const cw = Number(w);
    const ch = Number(h);
    if (cw > 0 && ch > 0) { setW(String(ch)); setH(String(cw)); onEmulate(customDevice(ch, cw)); }
  };

  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--v2-edge)] px-2.5 py-1">
      {DEVICE_PRESETS.map(p => {
        const on = device?.name === p.name;
        return (
          <button key={p.name} type="button" aria-pressed={on} title={`${p.name} · ${p.w} × ${p.h}${p.mobile ? " · mobile user agent" : ""}`}
            onClick={() => onEmulate(p)} className={`${PILL} ${on ? PILL_ON : PILL_OFF}`}>{p.name}</button>
        );
      })}
      <input aria-label="Device width" inputMode="numeric" placeholder="W" value={w}
        onChange={e => setW(e.target.value)} onKeyDown={sizeKey} className={SIZE_INPUT} />
      <span aria-hidden className="shrink-0 text-v2-small text-[var(--v2-muted)]">×</span>
      <input aria-label="Device height" inputMode="numeric" placeholder="H" value={h}
        onChange={e => setH(e.target.value)} onKeyDown={sizeKey} className={SIZE_INPUT} />
      <IconButton label="Rotate" title="Swap width and height" size={24} onClick={rotate}><RefreshCw size={13} aria-hidden /></IconButton>
      <span className="min-w-0 flex-1" />
      <span title="WebKit cannot fake touch or pixel density" className="shrink-0 text-v2-small text-[var(--v2-muted)]">size and user agent only</span>
      <button type="button" className={DONE} onClick={onDone}>Done</button>
    </div>
  );
}
