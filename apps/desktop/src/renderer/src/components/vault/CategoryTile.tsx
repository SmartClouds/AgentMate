import type { VaultCategoryColor, VaultCategoryIcon } from '@runova/core';
import { cn } from '@/lib/utils';
import { CATEGORY_COLORS, CATEGORY_ICONS } from './categoryMeta';

const SIZES = {
  sm: 'h-5 w-5 rounded-md [&>svg]:h-2.5 [&>svg]:w-2.5',
  md: 'h-7 w-7 rounded-lg [&>svg]:h-3.5 [&>svg]:w-3.5',
  lg: 'h-12 w-12 rounded-2xl [&>svg]:h-5 [&>svg]:w-5',
} as const;

/** A category's icon on a soft tile of its color, the way the rail and the pickers show it. */
export function CategoryTile({
  color,
  icon,
  size = 'md',
  className,
}: {
  color: VaultCategoryColor;
  icon: VaultCategoryIcon;
  size?: keyof typeof SIZES;
  className?: string;
}): React.JSX.Element {
  const { Icon } = CATEGORY_ICONS[icon];
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center ring-1 ring-inset',
        CATEGORY_COLORS[color].tile,
        SIZES[size],
        className,
      )}
    >
      <Icon />
    </span>
  );
}
