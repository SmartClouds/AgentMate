import { widgetCoversZone } from '@shared/cloudflare/turnstile';
import { cloudflareErrorCode, cloudflareErrorPermission } from '@shared/cloudflareErrors';
import type { CloudflareZone, TurnstileWidget } from '@shared/cloudflareTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Code, Pencil, Plus, RotateCw, ShieldSolid, Trash2 } from '@/components/icons';
import { Chip, EmptyState, FOOTER_HAIRLINE, PillTabs, SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cloudflareFailureText, useCloudflareError } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { CloudflareCard, Problem } from '../fields';
import { GuidedFix } from '../server/GuidedFix';
import { RotateSecretDialog } from './RotateSecretDialog';
import { WidgetDialog, type WidgetDialogMode } from './WidgetDialog';
import { ModeChip, TurnstileSecret } from './widgetParts';

/** With more widgets than this in view, the card offers a search. */
const SEARCH_FROM = 7;
const DOMAINS_SHOWN = 2;

type Scope = 'zone' | 'account';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function WidgetsSkeleton(): React.JSX.Element {
  return (
    <div className={cn(FOOTER_HAIRLINE, 'settings-rows')} aria-busy="true">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="space-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-3.5 w-3/5" />
        </div>
      ))}
    </div>
  );
}

function WidgetRow({
  zone,
  widget,
  onOpen,
  onRotate,
  onDelete,
}: {
  zone: CloudflareZone;
  widget: TurnstileWidget;
  onOpen: (mode: WidgetDialogMode) => void;
  onRotate: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const hidden = widget.domains.slice(DOMAINS_SHOWN);
  return (
    <li aria-label={widget.name} className="flex flex-wrap items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{widget.name}</span>
          <ModeChip mode={widget.mode} />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {widget.domains.slice(0, DOMAINS_SHOWN).map((domain) => (
            <Chip key={domain} className="font-mono">
              {domain}
            </Chip>
          ))}
          {hidden.length > 0 && (
            <SimpleTooltip label={hidden.join(', ')}>
              <span>
                <Chip>+{hidden.length}</Chip>
              </span>
            </SimpleTooltip>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex min-w-0 items-center gap-1">
            <span className="shrink-0 whitespace-nowrap text-muted-foreground">Site key</span>
            <code className="truncate font-mono text-foreground/90">{widget.sitekey}</code>
            <CopyButton text={widget.sitekey} label="Copy site key" alwaysVisible />
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 whitespace-nowrap text-muted-foreground">Secret</span>
            <TurnstileSecret zone={zone} sitekey={widget.sitekey} />
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="soft"
          size="sm"
          onClick={() => onOpen({ kind: 'ready', widget })}
        >
          <Code className="h-3.5 w-3.5" /> Add to your site
        </Button>
        <SimpleTooltip label="Edit">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${widget.name}`}
            onClick={() => onOpen({ kind: 'edit', widget })}
          >
            <Pencil />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Rotate secret">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Rotate the secret of ${widget.name}`}
            onClick={onRotate}
          >
            <RotateCw />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Delete">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${widget.name}`}
            className="hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </SimpleTooltip>
      </div>
    </li>
  );
}

/**
 * The zone's Turnstile tab (E43): Cloudflare's captcha. Widgets belong to the Cloudflare account,
 * so the tab shows the ones that cover this domain and keeps the rest of the account one click
 * away. A new widget starts from the domain; each one has its site key, its secret on request, the
 * code to paste, and edit, secret rotation and delete.
 */
export function TurnstileCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const queryClient = useQueryClient();
  const listKey = queryKeys.cloudflareTurnstile(zone.cloudflareAccountId);
  const widgets = useQuery({
    queryKey: listKey,
    queryFn: () => window.runova.cloudflare.listTurnstileWidgets(zone.id),
  });
  const problem = useCloudflareError(widgets.error);
  const [scope, setScope] = useState<Scope>('zone');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<WidgetDialogMode | null>(null);
  const [rotating, setRotating] = useState<TurnstileWidget | null>(null);

  async function remove(widget: TurnstileWidget): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete the ${widget.name} widget?`,
      description: `Forms that use the site key ${widget.sitekey} stop passing checks right away. This cannot be undone.`,
      confirmLabel: 'Delete widget',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.cloudflare.deleteTurnstileWidget(zone.id, widget.sitekey);
      toast.success(`Deleted ${widget.name}.`);
      queryClient.removeQueries({
        queryKey: queryKeys.cloudflareTurnstileSecret(zone.cloudflareAccountId, widget.sitekey),
      });
      await queryClient.invalidateQueries({ queryKey: listKey });
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    }
  }

  const all = widgets.data ?? [];
  const covering = all.filter((widget) => widgetCoversZone(widget, zone.name));
  const inScope = scope === 'zone' ? covering : all;
  const needle = search.trim().toLowerCase();
  const shown = inScope.filter(
    (widget) =>
      !needle ||
      widget.name.toLowerCase().includes(needle) ||
      widget.sitekey.toLowerCase().includes(needle) ||
      widget.domains.some((domain) => domain.includes(needle)),
  );
  const refused =
    cloudflareErrorCode(widgets.error) === 'missing-permission' &&
    cloudflareErrorPermission(widgets.error) === 'turnstile';
  const addForZone = (
    <Button onClick={() => setDialog({ kind: 'create' })}>
      <Plus className="h-3.5 w-3.5" /> Add a widget for {zone.name}
    </Button>
  );

  let body: React.ReactNode;
  if (widgets.isPending) {
    body = <WidgetsSkeleton />;
  } else if (widgets.isError) {
    body = (
      <div className={cn(FOOTER_HAIRLINE, 'p-4')}>
        {refused ? (
          <GuidedFix
            error={widgets.error}
            alternative={
              <Button
                type="button"
                size="sm"
                variant="link"
                className="px-0"
                onClick={() => void widgets.refetch()}
              >
                I added it, try again
              </Button>
            }
          />
        ) : (
          <Problem message={problem ?? ''} onRetry={() => void widgets.refetch()} />
        )}
      </div>
    );
  } else if (all.length === 0) {
    body = (
      <EmptyState
        size="md"
        icon={ShieldSolid}
        title="No Turnstile widgets yet"
        description="Turnstile is Cloudflare's free captcha. It stops bots on your forms, and most visitors never see a puzzle. You get the code to paste right after."
        className={FOOTER_HAIRLINE}
        action={addForZone}
      />
    );
  } else if (inScope.length === 0) {
    body = (
      <EmptyState
        size="md"
        icon={ShieldSolid}
        title={`No widget covers ${zone.name} yet`}
        description="Make one for this domain, or open a widget of the account and add the domain to it."
        className={FOOTER_HAIRLINE}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {addForZone}
            <Button variant="soft" onClick={() => setScope('account')}>
              See {plural(all.length, 'widget')} in this account
            </Button>
          </div>
        }
      />
    );
  } else {
    body = (
      <>
        {inScope.length >= SEARCH_FROM && (
          <div className={cn(FOOTER_HAIRLINE, 'px-4 py-2')}>
            <SearchPill
              type="search"
              label="Search widgets"
              clearLabel="Clear filter"
              placeholder="Search by name, domain or site key"
              value={search}
              onValueChange={setSearch}
            />
          </div>
        )}
        {shown.length === 0 ? (
          <p className={cn(FOOTER_HAIRLINE, 'px-4 py-6 text-center text-sm text-muted-foreground')}>
            No widget matches that.
          </p>
        ) : (
          <ul aria-label="Turnstile widgets" className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
            {shown.map((widget) => (
              <WidgetRow
                key={widget.sitekey}
                zone={zone}
                widget={widget}
                onOpen={setDialog}
                onRotate={() => setRotating(widget)}
                onDelete={() => void remove(widget)}
              />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <CloudflareCard
      icon={<ShieldSolid className="h-4 w-4" />}
      title="Turnstile"
      description={
        widgets.data
          ? `${covering.length} for ${zone.name}, ${all.length} in this Cloudflare account`
          : "Cloudflare's free captcha for your forms"
      }
      actions={
        all.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <PillTabs
              id={`turnstile-scope-${zone.id}`}
              label="Which widgets"
              kind="toggle"
              size="xs"
              items={[
                { value: 'zone', label: 'This domain', count: covering.length },
                { value: 'account', label: 'All in account', count: all.length },
              ]}
              value={scope}
              onChange={setScope}
            />
            <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
              <Plus className="h-3.5 w-3.5" /> Add widget
            </Button>
          </div>
        )
      }
    >
      {body}
      {dialog && (
        <WidgetDialog
          open
          zone={zone}
          mode={dialog}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
      )}
      {rotating && (
        <RotateSecretDialog
          open
          zone={zone}
          widget={rotating}
          onOpenChange={(open) => {
            if (!open) setRotating(null);
          }}
        />
      )}
    </CloudflareCard>
  );
}
