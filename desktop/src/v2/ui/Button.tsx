import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type ButtonVariant = "primary" | "ghost" | "quiet" | "danger";

const VARIANT = {
  primary: "bg-[var(--v2-text)] text-[var(--v2-ink)] font-semibold border border-transparent hover:bg-[var(--v2-knob)]",
  ghost: "bg-transparent text-[var(--v2-text)] border border-[var(--v2-edge-2)] hover:bg-[var(--v2-raised)]",
  quiet: "bg-transparent text-[var(--v2-muted)] border border-transparent hover:text-[var(--v2-text)] hover:bg-[var(--v2-raised)]",
  danger: "bg-[var(--v2-bad-soft)] text-[var(--v2-bad)] border border-[var(--v2-bad-edge)] hover:bg-[var(--v2-bad-hover)]",
} as const satisfies Record<ButtonVariant, string>;

export type ButtonProps = Omit<ComponentPropsWithoutRef<"button">, "disabled"> & {
  variant?: ButtonVariant;
  icon?: ReactNode;
  /** Disables the button and says why on hover; a disabled control always explains itself. */
  disabledReason?: string | null;
  children: ReactNode;
};

export function Button({ variant = "ghost", icon, disabledReason, children, className = "", title, type = "button", ...rest }: ButtonProps) {
  const disabled = !!disabledReason;
  return (
    <button {...rest} type={type} disabled={disabled} aria-disabled={disabled || undefined}
      title={disabled ? disabledReason ?? undefined : title} data-variant={variant}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-[11px] py-[6px] text-v2-body font-medium transition-colors disabled:opacity-45 ${VARIANT[variant]} ${className}`}>
      {icon}{children}
    </button>
  );
}
