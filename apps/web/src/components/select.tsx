import * as RadixSelect from "@radix-ui/react-select";
import type { ReactNode } from "react";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Shown before the label, e.g. a class id. */
  hint?: ReactNode;
}

/**
 * A dropdown in the app's style, built on Radix Select (the base of shadcn/ui's Select): keyboard
 * and screen-reader support, typeahead, and a menu that stays inside the screen.
 */
export function Select({
  value,
  onChange,
  options,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** A short label shown inside the trigger, before the chosen value. */
  label?: ReactNode;
  placeholder?: string;
}) {
  return (
    <RadixSelect.Root value={value} onValueChange={onChange}>
      <RadixSelect.Trigger className="inline-flex h-9 items-center gap-2 rounded-full border border-line-strong px-4 text-[13px] text-ink outline-none hover:bg-white/[0.04] focus-visible:border-accent data-[state=open]:border-accent">
        {label && <span className="text-muted">{label}</span>}
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="text-muted">
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={8}
          align="end"
          className="z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-2xl border border-line-strong bg-raised p-1.5 shadow-(--shadow-raised) [animation:rise_.15s_ease_both]"
        >
          <RadixSelect.Viewport>
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-pointer items-center gap-3 rounded-xl py-2 pr-9 pl-3 text-sm text-soft outline-none select-none data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-ink data-[state=checked]:text-ink"
              >
                {o.hint !== undefined && (
                  <span className="w-8 font-mono text-xs text-muted">{o.hint}</span>
                )}
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="absolute right-3 text-accent">
                  <svg
                    viewBox="0 0 24 24"
                    className="size-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
