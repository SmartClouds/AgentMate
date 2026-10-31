import type { AppSettings } from '@runova/core';
import {
  isCategoryShown,
  NEWS_NOTIFY_LEVELS,
  type NewsNotifyLevel,
  newsSettingsOf,
} from '@shared/newsSettings';
import { NEWS_CATEGORIES, type NewsCategory } from '@shared/newsTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { toast } from 'sonner';
import { CATEGORY_META, SEVERITY_META } from '@/components/dashboard/newsParts';
import { Bell, Filter, Newspaper } from '@/components/icons';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

type NewsPatch = Partial<
  Pick<AppSettings, 'newsEnabled' | 'newsCategories' | 'newsNotifyMinSeverity'>
>;

const NOTIFY_OPTIONS = NEWS_NOTIFY_LEVELS.map((level) => ({
  value: level,
  label: level === 'never' ? 'Never' : SEVERITY_META[level].label,
}));

function isNotifyLevel(value: string): value is NewsNotifyLevel {
  return NEWS_NOTIFY_LEVELS.some((level) => level === value);
}

function Row({
  icon: Icon,
  title,
  description,
  control,
  children,
}: {
  icon: typeof Bell;
  title: string;
  description: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold leading-none">{title}</h3>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children ? <div className="mt-3 pl-12">{children}</div> : null}
    </div>
  );
}

/**
 * The News card in Settings > Notifications (E42): whether the Dashboard shows news at all (off
 * also stops main from checking), which categories it shows, and the lowest severity of a security
 * fix for a tool on this machine that notifies. Each change saves at once.
 */
export function NewsSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const idPrefix = useId();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const save = useMutation({
    mutationFn: (patch: NewsPatch) => window.runova.settings.update(patch),
    meta: { silentLoading: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
    onError: () => toast.error('Could not save the news settings.'),
  });

  // The controls show what was just picked until the saved value comes back.
  const news = newsSettingsOf({
    ...settingsQuery.data,
    ...(save.isPending ? save.variables : {}),
  });
  const off = !news.enabled;

  const toggleCategory = (category: NewsCategory, on: boolean) => {
    const shown = new Set(NEWS_CATEGORIES.filter((one) => isCategoryShown(news.categories, one)));
    if (on) shown.add(category);
    else shown.delete(category);
    // Every category ticked is saved as none, so a category added later shows up too.
    const next =
      shown.size === NEWS_CATEGORIES.length ? [] : NEWS_CATEGORIES.filter((one) => shown.has(one));
    save.mutate({ newsCategories: next });
  };

  const onlyOne = news.categories.length === 1;

  // The switch and boxes wait for the saved values, so they never flash the defaults first.
  if (!settingsQuery.data) {
    return (
      <div className="space-y-3 px-5 py-4" aria-label="Loading news settings">
        <Skeleton className="h-9 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
      </div>
    );
  }

  return (
    <>
      <Row
        icon={Newspaper}
        title="Show news"
        description="Technology news from runovahq.com on the Dashboard, with a mark on the security fixes that affect the tools on this computer. Turning it off hides the News card and stops Runova from checking for news."
        control={
          <Switch
            checked={news.enabled}
            onCheckedChange={(checked) => save.mutate({ newsEnabled: checked })}
            aria-label="Show news"
          />
        }
      >
        <p className="text-xs text-muted-foreground">
          Checking for news sends no personal data and nothing about the tools on this computer.
          Matching news to your tools happens here.
        </p>
      </Row>
      <Row
        icon={Filter}
        title="Categories to show"
        description="News in a category you untick stays off the card and the full list."
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
          {NEWS_CATEGORIES.map((category) => {
            const checked = isCategoryShown(news.categories, category);
            const id = `${idPrefix}-${category}`;
            return (
              <label
                key={category}
                htmlFor={id}
                className={cn(
                  'flex items-center gap-2 text-sm',
                  off ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                )}
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  // The last ticked one stays, since none at all is saved as every one.
                  disabled={off || (onlyOne && checked)}
                  onCheckedChange={(on) => toggleCategory(category, on === true)}
                />
                {CATEGORY_META[category].label}
              </label>
            );
          })}
        </div>
      </Row>
      <Row
        icon={Bell}
        title="Notify me about security fixes at"
        description="A security fix for a tool installed on this computer sends one notification when it is at this severity or above. Each item notifies once at most."
        control={
          <Combobox
            ariaLabel="Notify me about security fixes at"
            className="w-40"
            value={news.notifyMinSeverity}
            disabled={off}
            onChange={(value) => {
              if (isNotifyLevel(value)) save.mutate({ newsNotifyMinSeverity: value });
            }}
            searchable={false}
            options={NOTIFY_OPTIONS}
          />
        }
      />
    </>
  );
}
