import { avatarHue, avatarLetter, type VaultEntrySummary } from '@runova/core';
import { cn } from '@/lib/utils';
import { ENTRY_TYPE_META } from './entryTypes';

/**
 * The theme tints a letter tile can take. The site's hash picks one, so the same account keeps
 * its colour everywhere while every theme still controls the palette. Destructive is left out,
 * since a red tile would read as a problem with the entry.
 */
const LETTER_TINTS = [
  'bg-primary/12 text-primary ring-primary/25',
  'bg-success/12 text-success ring-success/25',
  'bg-warning/12 text-warning ring-warning/25',
  'bg-foreground/[0.07] text-foreground/75 ring-foreground/[0.12]',
] as const;

/**
 * The entry's saved favicon, or a letter tile tinted by site (or title) so the same account
 * keeps its color everywhere. The favicon is only ever downloaded from the editor and then
 * stored in the vault, so drawing the list never contacts a site.
 */
export function EntryAvatar({
  entry,
  size = 'md',
}: {
  entry: Pick<VaultEntrySummary, 'title' | 'host' | 'type' | 'icon'>;
  size?: 'sm' | 'md' | 'lg';
}): React.JSX.Element {
  const hue = avatarHue(entry.host || entry.title.toLowerCase());
  const TypeIcon = ENTRY_TYPE_META[entry.type].icon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-lg font-semibold',
        size === 'lg' && 'h-12 w-12 text-lg',
        size === 'md' && 'h-9 w-9 text-sm',
        size === 'sm' && 'h-6 w-6 rounded-md text-[11px]',
        'ring-1 ring-inset',
        entry.icon
          ? 'bg-background ring-border'
          : LETTER_TINTS[Math.floor(hue / (360 / LETTER_TINTS.length)) % LETTER_TINTS.length],
      )}
    >
      {entry.icon ? (
        <img
          src={entry.icon}
          alt=""
          draggable={false}
          className={cn('object-contain', size === 'sm' ? 'h-4 w-4' : 'h-3/5 w-3/5')}
        />
      ) : (
        avatarLetter(entry.title)
      )}
      {entry.type !== 'login' && size !== 'sm' && (
        <span
          className={cn(
            'absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border',
            size === 'lg' ? 'h-5 w-5' : 'h-4 w-4',
          )}
        >
          <TypeIcon className={size === 'lg' ? 'h-2.5 w-2.5' : 'h-2 w-2'} />
        </span>
      )}
    </span>
  );
}
