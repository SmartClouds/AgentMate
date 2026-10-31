import { useQueryClient } from '@tanstack/react-query';
import { Command as CommandPrimitive } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Newspaper, RefreshCw } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { NEWS_ALL_PARAM } from './NewsCard';
import { useNewsEnabled } from './newsParts';

// Same look as the palette's other groups.
const groupClass =
  'px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground/60';
const itemClass =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground';

/** The news part of the command palette (E42). Gone while news is off in Settings. */
export function NewsPaletteGroup({ onDone }: { onDone: () => void }): React.JSX.Element | null {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const enabled = useNewsEnabled();
  if (!enabled) return null;

  return (
    <CommandPrimitive.Group heading="News" className={groupClass}>
      <CommandPrimitive.Item
        value="open news dashboard security technology view all"
        className={itemClass}
        onSelect={() => {
          onDone();
          navigate(`/?${NEWS_ALL_PARAM}=1`);
        }}
      >
        <Newspaper className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        Open news
      </CommandPrimitive.Item>
      <CommandPrimitive.Item
        value="refresh news check for news now"
        className={itemClass}
        onSelect={() => {
          onDone();
          window.runova.news.refresh().then(
            () => queryClient.invalidateQueries({ queryKey: queryKeys.newsLists }),
            () => toast.error('Could not check for news.'),
          );
        }}
      >
        <RefreshCw className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        Refresh news
      </CommandPrimitive.Item>
    </CommandPrimitive.Group>
  );
}
