import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Command as CommandPrimitive } from 'cmdk';
import { useState } from 'react';
import { Check, ChevronsUpDown, Search } from '@/components/icons';
import { FIELD_SURFACE } from '@/components/ui/input';
import { LIST_OPTION, LIST_SEARCH, OVERLAY_MOTION, OVERLAY_SURFACE } from '@/components/ui/overlay';
import { cn } from '@/lib/utils';

export interface MultiComboboxOption {
  value: string;
  label: string;
  /** Shown dimmed after the label, such as the organization a project belongs to. */
  detail?: string;
  keywords?: string[];
}

/**
 * The Combobox's look for picking several values: the trigger lists what is picked, and choosing
 * an option toggles it without closing the list. Built for linking Sentry projects (E24); it
 * belongs in `ui/` once a second caller needs it.
 */
export function MultiCombobox({
  options,
  values,
  onChange,
  ariaLabel,
  placeholder = 'Pick…',
  searchPlaceholder = 'Search…',
  emptyText = 'No results found.',
  disabled,
  className,
}: {
  options: MultiComboboxOption[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  ariaLabel: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const picked = options.filter((one) => values.includes(one.value));

  function toggle(value: string): void {
    onChange(values.includes(value) ? values.filter((one) => one !== value) : [...values, value]);
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            FIELD_SURFACE,
            'flex min-h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-full py-1 pl-1.5 pr-2.5 text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {picked.length === 0 ? (
              <span className="truncate pl-2 text-muted-foreground">{placeholder}</span>
            ) : (
              picked.map((one) => (
                <span
                  key={one.value}
                  className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-primary/12 px-2 text-xs font-medium text-primary"
                >
                  <span className="truncate">{one.label}</span>
                </span>
              ))
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className={cn(
            OVERLAY_SURFACE,
            OVERLAY_MOTION,
            'z-50 w-[var(--radix-popover-trigger-width)] min-w-64 overflow-hidden origin-[var(--radix-popover-content-transform-origin)]',
          )}
        >
          <CommandPrimitive
            className="flex flex-col"
            filter={(value, text) => (value.toLowerCase().includes(text.toLowerCase()) ? 1 : 0)}
          >
            <div className="p-1 pb-0">
              <div className={LIST_SEARCH}>
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <CommandPrimitive.Input
                  autoFocus
                  value={search}
                  onValueChange={setSearch}
                  placeholder={searchPlaceholder}
                  className="h-full w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
            <CommandPrimitive.List
              aria-multiselectable
              className="rail-scroll max-h-64 overflow-y-auto p-1"
            >
              <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
                {emptyText}
              </CommandPrimitive.Empty>
              {options.map((option) => {
                const on = values.includes(option.value);
                return (
                  <CommandPrimitive.Item
                    key={option.value}
                    value={[option.label, option.detail ?? '', ...(option.keywords ?? [])].join(
                      ' ',
                    )}
                    onSelect={() => toggle(option.value)}
                    aria-checked={on}
                    className={LIST_OPTION}
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-primary',
                        on ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="truncate">{option.label}</span>
                    {option.detail && (
                      <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
                        {option.detail}
                      </span>
                    )}
                  </CommandPrimitive.Item>
                );
              })}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
