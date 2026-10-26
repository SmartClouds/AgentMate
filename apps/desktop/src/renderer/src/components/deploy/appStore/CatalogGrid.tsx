import type { AnyCatalogTemplate } from '@runova/core';
import { useMemo, useState } from 'react';
import { CircleCheck, Store } from '@/components/icons';
import {
  CARD_GRID,
  EmptyState,
  GLASS_CARD,
  SECTION_HEADING,
  SearchPill,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  allOfficial,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  memoryText,
} from '@/lib/deploy/appStore/format';
import { cn } from '@/lib/utils';
import { GLASS_EDGE } from '../deployKit';

/**
 * The catalog, by category: what each app is, who publishes its images and what it needs, with
 * a filter by name. Every card opens the same install sheet.
 */

function AppCard({
  template,
  canInstall,
  onInstall,
}: {
  template: AnyCatalogTemplate;
  canInstall: boolean;
  onInstall: (templateId: string) => void;
}): React.JSX.Element {
  const version = template.versions.find((item) => item.id === template.defaultVersion);
  const official = version ? allOfficial(version) : false;
  const install = (
    <Button
      size="sm"
      disabled={!canInstall}
      onClick={() => onInstall(template.id)}
      aria-label={`Install ${template.name}`}
    >
      Install
    </Button>
  );
  return (
    <li
      aria-label={template.name}
      className={cn(
        GLASS_CARD,
        GLASS_EDGE.interactive,
        'flex flex-col gap-2 p-4 transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 motion-reduce:hover:translate-y-0',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <div
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-sm font-semibold text-primary"
          >
            {template.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h4 className="truncate text-sm font-semibold text-foreground">{template.name}</h4>
            <p className="truncate text-xs text-muted-foreground">{version?.label}</p>
          </div>
        </div>
        {canInstall ? (
          install
        ) : (
          <SimpleTooltip label="Installing apps needs the Operator role or higher." wrapTrigger>
            {install}
          </SimpleTooltip>
        )}
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{template.description}</p>
      <p className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CircleCheck className="h-3 w-3 text-success" />
          {official ? 'Official image' : 'Verified publisher'}
        </span>
        <span>Needs {memoryText(template.minMemoryMb)}</span>
      </p>
    </li>
  );
}

export function CatalogGrid({
  templates,
  canInstall,
  onInstall,
}: {
  templates: readonly AnyCatalogTemplate[];
  canInstall: boolean;
  onInstall: (templateId: string) => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const shown = templates.filter(
      (template) =>
        needle === '' ||
        template.name.toLowerCase().includes(needle) ||
        template.description.toLowerCase().includes(needle),
    );
    return CATEGORY_ORDER.map((category) => ({
      category,
      templates: shown.filter((template) => template.category === category),
    })).filter((group) => group.templates.length > 0);
  }, [templates, filter]);

  return (
    <section aria-label="Catalog" className="@container/grid flex flex-col gap-2">
      <div
        className={cn(GLASS_CARD, 'flex flex-wrap items-center justify-between gap-3 px-4 py-3')}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <Store className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-semibold">Catalog</h3>
        </div>
        <SearchPill
          label="Find an app"
          placeholder="Find an app"
          clearLabel="Clear filter"
          value={filter}
          onValueChange={setFilter}
          className="w-64 max-w-full"
        />
      </div>
      {groups.length === 0 ? (
        <EmptyState
          card
          size="sm"
          icon={Store}
          title={`No app matches ${JSON.stringify(filter)}.`}
        />
      ) : (
        groups.map((group) => (
          <div key={group.category} className="space-y-2">
            <h4 className={cn(SECTION_HEADING, 'px-1 pt-2')}>{CATEGORY_LABEL[group.category]}</h4>
            <ul aria-label={CATEGORY_LABEL[group.category]} className={CARD_GRID}>
              {group.templates.map((template) => (
                <AppCard
                  key={template.id}
                  template={template}
                  canInstall={canInstall}
                  onInstall={onInstall}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
