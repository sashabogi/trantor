import { Check } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

export type CheckboxProps = Omit<ComponentPropsWithoutRef<"input">, "type">;

export function Checkbox({ className = "", ...props }: CheckboxProps) {
  return (
    <span className={`relative inline-flex h-4 w-4 shrink-0 ${className}`}>
      <input {...props} type="checkbox"
        className="peer m-0 h-4 w-4 appearance-none rounded-sm border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] checked:border-[var(--v2-accent)] checked:bg-[var(--v2-accent)] disabled:opacity-45" />
      <Check aria-hidden className="pointer-events-none absolute left-[2px] top-[2px] h-3 w-3 text-[var(--v2-ink)] opacity-0 peer-checked:opacity-100 peer-disabled:opacity-45" strokeWidth={3} />
    </span>
  );
}
