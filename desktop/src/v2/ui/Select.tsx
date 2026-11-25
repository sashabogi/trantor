import type { ComponentPropsWithoutRef } from "react";

export type SelectProps = ComponentPropsWithoutRef<"select">;

export function Select({ className = "", children, ...props }: SelectProps) {
  return (
    <select {...props} className={`cursor-pointer rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2 py-[5px] text-[12px] text-[var(--v2-text)] outline-none focus:border-[var(--v2-accent)] disabled:cursor-not-allowed disabled:opacity-45 ${className}`}>
      {children}
    </select>
  );
}
