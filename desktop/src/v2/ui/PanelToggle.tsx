// #14512: the one panel-toggle primitive, docs/design/v2/PanelToggles.dc.html §B. A window
// outline whose shaded part is the panel: shaded means open; outline with a divider is closed.
// Hover previews the click by fading the fill (open .35, closed .45; focus swaps geometry) over
// 160ms, off under reduced motion. 28px target, 20px drawing, aria-pressed, name = tooltip.
import type { ComponentPropsWithoutRef } from "react";

export type PanelToggleSide = "left" | "bottom" | "right" | "focus";

export type PanelToggleProps = Omit<ComponentPropsWithoutRef<"button">, "aria-pressed" | "aria-label" | "title" | "onClick"> & {
  side: PanelToggleSide;
  /** The panel is on screen: the shade is drawn in the text colour and aria-pressed is true. */
  open: boolean;
  /** The tooltip, which is also the accessible name. */
  tooltip: string;
  onToggle: () => void;
};

// The geometry from §B: the shade is the band where the panel sits inside the window outline.
const SHADE = {
  left: { x: 3.2, y: 4.2, w: 4.6, h: 11.6 },
  bottom: { x: 3.2, y: 11.2, w: 13.6, h: 4.6 },
  right: { x: 12.2, y: 4.2, w: 4.6, h: 11.6 },
} as const satisfies Record<Exclude<PanelToggleSide, "focus">, { x: number; y: number; w: number; h: number }>;

// Closed: a divider where the panel would sit, so the icon still reads as the layout.
const DIVIDER = { left: "M8 4v12", bottom: "M3 11h14", right: "M12 4v12" } as const satisfies Record<Exclude<PanelToggleSide, "focus">, string>;

export function PanelToggle({ side, open, tooltip, onToggle, disabled, className = "", type = "button", ...rest }: PanelToggleProps) {
  return (
    <button {...rest} type={type} className={`v2-panel-toggle${className ? ` ${className}` : ""}`}
      data-side={side} data-open={open ? "true" : "false"} aria-pressed={open} aria-label={tooltip} title={tooltip}
      disabled={disabled} onClick={onToggle}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        {side !== "focus" ? (
          <>
            <rect className="v2-pt-shade" x={SHADE[side].x} y={SHADE[side].y} width={SHADE[side].w} height={SHADE[side].h} rx="1.2" fill="currentColor" />
            <path className="v2-pt-divider" d={DIVIDER[side]} fill="none" stroke="currentColor" strokeWidth="1.1" />
          </>
        ) : (
          <>
            <rect className="v2-pt-focus-full" x="3.4" y="4.4" width="13.2" height="11.2" rx="1.2" />
            <rect className="v2-pt-focus-in" x="6.5" y="6.5" width="7" height="7" rx="1" />
            <rect className="v2-pt-focus-preview" x="4" y="5" width="12" height="10" rx="1" />
          </>
        )}
      </svg>
    </button>
  );
}
