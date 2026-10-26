import type { SiteInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Lock, LockOpen, Route, Server } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { certificateBadge } from '@/lib/deploy/sites/certificates';
import type { SiteTab } from '@/lib/deploy/sites/problems';
import { cn } from '@/lib/utils';

/**
 * How a request reaches the app: the domain (with its lock and the days left), nginx (with what
 * it does on the way) and the upstream. Each stop opens the editor on the tab that changes it.
 */

const TONE = { ok: 'text-success', warn: 'text-warning', bad: 'text-destructive' } as const;

export function upstreamLabel(site: SiteInfo): string {
  const upstream = site.settings.upstream;
  if (upstream.kind === 'url' || upstream.kind === 'endpoint') return upstream.address ?? '';
  return `${upstream.service ?? 'local'}:${upstream.port ?? ''}`;
}

/** What nginx does to the site's traffic, as short words. */
export function siteChips(site: SiteInfo): string[] {
  const s = site.settings;
  return [
    s.proxyCache ? 'cache' : null,
    s.websocket ? 'websocket' : null,
    s.gzip ? 'gzip' : null,
    s.redirectToHttps ? 'https only' : null,
    s.basicAuth ? 'password' : null,
    s.ipRules && s.ipRules.allow.length > 0 ? 'ip allowlist' : null,
    s.rateLimit ? 'rate limit' : null,
    site.serverSnippet || site.locationSnippet ? 'custom' : null,
  ].filter((chip): chip is string => chip !== null);
}

function Stop({
  label,
  tooltip,
  onOpen,
  children,
  className,
}: {
  label: string;
  tooltip: string;
  onOpen: () => void;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={tooltip}>
      <button
        type="button"
        aria-label={label}
        onClick={onOpen}
        className={cn(
          // A soft well with an inset ring: a tinted border would lose to the global border colour.
          'flex min-w-0 cursor-pointer items-center gap-2 rounded-xl bg-foreground/[0.03] px-2.5 py-1.5 text-left text-xs ring-1 ring-inset ring-foreground/[0.07] transition-colors hover:bg-foreground/[0.06] hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        {children}
      </button>
    </SimpleTooltip>
  );
}

function Wire(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="hidden h-px w-5 shrink-0 bg-gradient-to-r from-foreground/15 to-primary/50 sm:block"
    />
  );
}

export function RouteMap({
  site,
  now,
  onOpen,
}: {
  site: SiteInfo;
  now: number;
  onOpen: (tab: SiteTab) => void;
}): React.JSX.Element {
  const badge = certificateBadge(site.certificate, now);
  const Mark = site.certificate ? Lock : LockOpen;
  const domain = site.settings.domains[0] ?? site.settings.id;
  const more = site.settings.domains.length - 1;
  const chips = siteChips(site);
  return (
    <div
      role="group"
      aria-label={`Route for ${domain}`}
      className="flex flex-wrap items-center gap-y-2 sm:flex-nowrap"
    >
      <Stop
        label={`${domain}, ${badge.label}. Edit domains and SSL`}
        tooltip={badge.description}
        onOpen={() => onOpen('ssl')}
        className="max-w-[16rem]"
      >
        <Mark className={cn('h-3.5 w-3.5 shrink-0', TONE[badge.tone])} />
        <span className="min-w-0">
          <span className="block truncate font-mono text-foreground">
            {domain}
            {more > 0 && <span className="text-muted-foreground"> +{more}</span>}
          </span>
          <span className={cn('block', TONE[badge.tone])}>{badge.label}</span>
        </span>
      </Stop>
      <Wire />
      <Stop
        label={`nginx: ${chips.length > 0 ? chips.join(', ') : 'plain proxy'}. Edit performance`}
        tooltip="What nginx does on the way"
        onOpen={() => onOpen('performance')}
      >
        <Route className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="flex flex-wrap gap-1">
          <span className="text-foreground">nginx</span>
          {chips.map((chip) => (
            <Chip key={chip} className="h-4 px-1.5 text-[10px] uppercase tracking-wide">
              {chip}
            </Chip>
          ))}
        </span>
      </Stop>
      <Wire />
      <Stop
        label={`Upstream ${upstreamLabel(site)}. Edit the proxy`}
        tooltip="Where requests go"
        onOpen={() => onOpen('proxy')}
      >
        <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-foreground">{upstreamLabel(site)}</span>
      </Stop>
    </div>
  );
}
