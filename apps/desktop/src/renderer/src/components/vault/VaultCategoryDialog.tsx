import {
  normalizeCategoryName,
  VAULT_CATEGORY_LIMITS,
  type VaultCategory,
  type VaultCategoryColor,
  type VaultCategoryIcon,
} from '@runova/core';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Check, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CategoryTile } from './CategoryTile';
import {
  CATEGORY_COLOR_ORDER,
  CATEGORY_COLORS,
  CATEGORY_ICON_ORDER,
  CATEGORY_ICONS,
} from './categoryMeta';

/** Arrow keys move the choice within a radio group, the way native radios behave. */
function onRadioKeyDown<T>(
  event: React.KeyboardEvent<HTMLElement>,
  options: readonly T[],
  current: T,
  pick: (value: T) => void,
): void {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const next = options[(options.indexOf(current) + step + options.length) % options.length];
  pick(next);
  const group = event.currentTarget.closest('[role="radiogroup"]');
  requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
}

export function VaultCategoryDialog({
  open,
  onOpenChange,
  category,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The category to edit. Without one the dialog makes a new category. */
  category?: VaultCategory;
  onSaved?: (category: VaultCategory) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const nameId = useId();
  const [name, setName] = useState(category?.name ?? '');
  const [color, setColor] = useState<VaultCategoryColor>(category?.color ?? 'blue');
  const [icon, setIcon] = useState<VaultCategoryIcon>(category?.icon ?? 'folder');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = category !== undefined;
  const tidy = normalizeCategoryName(name);
  const ready = tidy !== '' && !busy;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await window.runova.vault.saveCategory({
        ...(editing ? { id: category.id } : {}),
        name: tidy,
        color,
        icon,
      });
      // In the cache at once, so pickers and the rail show it before the refetch lands.
      queryClient.setQueryData<VaultCategory[]>(queryKeys.vaultCategories, (list = []) => [
        ...list.filter((c) => c.id !== saved.id),
        saved,
      ]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vaultCategories });
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={(event) => void submit(event)} className="contents">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit category' : 'New category'}</DialogTitle>
            <DialogDescription>
              Categories work like folders. Each entry can sit in one of them.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {/* What the rail will show, updated as you type and pick. */}
            <div
              data-testid="category-preview"
              className={cn(
                'flex items-center gap-3 rounded-2xl px-4 py-3.5 ring-1 ring-inset transition-colors',
                CATEGORY_COLORS[color].wash,
              )}
            >
              <CategoryTile color={color} icon={icon} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold tracking-tight">
                  {tidy || 'Untitled category'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {CATEGORY_COLORS[color].label} · {CATEGORY_ICONS[icon].label}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                autoFocus
                value={name}
                maxLength={VAULT_CATEGORY_LIMITS.name}
                placeholder="Work, Banking, Side projects..."
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
              />
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <p id={`${nameId}-color`} className="text-sm font-medium">
                Color
              </p>
              <div
                role="radiogroup"
                aria-labelledby={`${nameId}-color`}
                className="flex flex-wrap gap-2"
              >
                {CATEGORY_COLOR_ORDER.map((option) => {
                  const checked = option === color;
                  return (
                    <SimpleTooltip key={option} label={CATEGORY_COLORS[option].label}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        aria-label={CATEGORY_COLORS[option].label}
                        tabIndex={checked ? 0 : -1}
                        onClick={() => setColor(option)}
                        onKeyDown={(event) =>
                          onRadioKeyDown(event, CATEGORY_COLOR_ORDER, color, setColor)
                        }
                        className={cn(
                          'relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-background transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring',
                          CATEGORY_COLORS[option].swatch,
                          checked && 'ring-2 ring-foreground/70',
                        )}
                      >
                        {checked && <Check className="h-3 w-3 text-white" />}
                      </button>
                    </SimpleTooltip>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <p id={`${nameId}-icon`} className="text-sm font-medium">
                Icon
              </p>
              <div
                role="radiogroup"
                aria-labelledby={`${nameId}-icon`}
                className="grid grid-cols-6 gap-1.5"
              >
                {CATEGORY_ICON_ORDER.map((option) => {
                  const checked = option === icon;
                  const { Icon, label } = CATEGORY_ICONS[option];
                  return (
                    <SimpleTooltip key={option} label={label}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        aria-label={label}
                        tabIndex={checked ? 0 : -1}
                        onClick={() => setIcon(option)}
                        onKeyDown={(event) =>
                          onRadioKeyDown(event, CATEGORY_ICON_ORDER, icon, setIcon)
                        }
                        className={cn(
                          'flex h-10 cursor-pointer items-center justify-center rounded-xl outline-none ring-1 ring-inset transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                          checked
                            ? CATEGORY_COLORS[color].tile
                            : 'text-muted-foreground ring-foreground/[0.08] hover:bg-foreground/[0.06] hover:text-foreground',
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    </SimpleTooltip>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              {busy && <Spinner className="h-3 w-3 animate-spin" />}
              {editing ? 'Save' : 'Create category'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
