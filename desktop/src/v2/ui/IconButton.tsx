import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type IconButtonProps = Omit<ComponentPropsWithoutRef<"button">, "aria-label" | "title" | "children"> & {
  /** Accessible name, required: an icon alone says nothing to a screen reader. */
  label: string;
  /** Hover text, required: what the click does. */
  title: string;
  children: ReactNode;
  size?: number;
  variant?: "outline" | "plain";
  round?: boolean;
  /** Count badge in the corner; 0 or null hides it. */
  badge?: number | null;
  badgeTone?: "warn" | "info";
};

export function IconButton({ label, title, children, size = 28, variant = "plain", round, badge, badgeTone = "warn",
  className = "", type = "button", ...rest }: IconButtonProps) {
  const border = variant === "outline" ? "1px solid var(--v2-edge-2)" : "0";
  return (
    <button {...rest} type={type} aria-label={label} title={title}
      className={`v2-hover relative inline-flex shrink-0 items-center justify-center bg-transparent text-[var(--v2-text-2)] disabled:opacity-45 ${className}`}
      style={{ width: size, height: size, borderRadius: round ? "50%" : Math.round(size / 4), border }}>
      {children}
      {!!badge && (
        <span data-badge className="absolute flex min-w-4 items-center justify-center rounded-full px-1 text-v2-micro font-bold"
          style={{ top: -4, right: -4, height: 16,
            background: badgeTone === "warn" ? "var(--v2-warn)" : "var(--v2-accent)",
            color: badgeTone === "warn" ? "var(--v2-warn-ink)" : "var(--v2-ink)" }}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
