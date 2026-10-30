import type { VaultCategory } from '@runova/core';
import { forwardRef, useState } from 'react';
import { ChevronsUpDown, FolderPlus, Inbox } from '@/components/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { CategoryTile } from './CategoryTile';
import { VaultCategoryDialog } from './VaultCategoryDialog';

const NONE = '__none__';

/** Picks the category an entry is filed under, with a shortcut to make a new one. */
export const CategoryPicker = forwardRef<
  HTMLButtonElement,
  {
    id?: string;
    categories: VaultCategory[];
    value: string | null;
    onChange: (categoryId: string | null) => void;
    disabled?: boolean;
  }
>(function CategoryPicker({ id, categories, value, onChange, disabled }, ref) {
  const [creating, setCreating] = useState(false);
  // The one just made here, shown until the refreshed list includes it.
  const [made, setMade] = useState<VaultCategory | null>(null);
  const current =
    categories.find((c) => c.id === value) ?? (made && made.id === value ? made : null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            ref={ref}
            id={id}
            type="button"
            className={cn(
              'flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-transparent px-2 text-left text-sm shadow-xs outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {current ? (
              <CategoryTile color={current.color} icon={current.icon} size="sm" />
            ) : (
              <span
                aria-hidden
                className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground ring-1 ring-inset ring-foreground/[0.08]"
              >
                <Inbox className="h-2.5 w-2.5" />
              </span>
            )}
            <span className={cn('min-w-0 flex-1 truncate', !current && 'text-muted-foreground')}>
              {current?.name ?? 'No category'}
            </span>
            <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] min-w-52"
        >
          <DropdownMenuRadioGroup
            value={value ?? NONE}
            onValueChange={(next) => onChange(next === NONE ? null : next)}
          >
            <DropdownMenuRadioItem value={NONE}>
              <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
              No category
            </DropdownMenuRadioItem>
            {categories.map((category) => (
              <DropdownMenuRadioItem key={category.id} value={category.id}>
                <CategoryTile color={category.color} icon={category.icon} size="sm" />
                {category.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <FolderPlus className="h-3.5 w-3.5" />
            New category...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {creating && (
        <VaultCategoryDialog
          open
          onOpenChange={(open) => !open && setCreating(false)}
          onSaved={(category) => {
            setMade(category);
            onChange(category.id);
          }}
        />
      )}
    </>
  );
});
