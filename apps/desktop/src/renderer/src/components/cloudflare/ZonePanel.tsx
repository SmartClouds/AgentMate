import type { CloudflareZone } from '@shared/cloudflareTypes';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { Globe } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE, GLASS_CARD } from '@/components/pageKit';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { AccessRulesCard } from './AccessRulesCard';
import { CachingCard } from './CachingCard';
import { CustomRulesCard } from './CustomRulesCard';
import { DnsRecordsCard } from './DnsRecordsCard';
import { Notice } from './fields';
import { PurgeCard } from './PurgeCard';
import { SecurityLevelCard } from './SecurityLevelCard';
import { SslTlsCard } from './SslTlsCard';
import { DnsTokensCard } from './server/DnsTokensCard';
import { TurnstileCard } from './turnstile/TurnstileCard';
import { ZoneQuickToggles } from './ZoneQuickToggles';
import { zoneStateText } from './ZoneRail';

export type ZoneTab = 'dns' | 'ssl' | 'caching' | 'security' | 'servers' | 'turnstile';

const TABS: { value: ZoneTab; label: string }[] = [
  { value: 'dns', label: 'DNS' },
  { value: 'ssl', label: 'SSL/TLS' },
  { value: 'caching', label: 'Caching' },
  { value: 'security', label: 'Security' },
  { value: 'servers', label: 'Servers' },
  { value: 'turnstile', label: 'Turnstile' },
];

/**
 * The tab an address asks for, else DNS. Settings was split into SSL/TLS and Caching, so an older
 * link to it opens SSL/TLS, where the SSL/TLS mode it used to show still is.
 */
export function zoneTab(value: string | null): ZoneTab {
  if (value === 'settings') return 'ssl';
  return TABS.find((tab) => tab.value === value)?.value ?? 'dns';
}

/** The tab content sits straight under the header card, spaced like every other card. */
const CONTENT = 'mt-0 flex flex-col gap-2 focus-visible:ring-offset-0';

/**
 * One zone: its state with the two switches an emergency needs, and by tab its DNS records, its
 * SSL/TLS, its caching, its rules, the DNS tokens its servers hold for DNS-01, and the Turnstile
 * widgets (captcha) that cover it.
 */
export function ZonePanel({
  zone,
  tab,
  onTabChange,
}: {
  zone: CloudflareZone;
  tab: ZoneTab;
  onTabChange: (tab: ZoneTab) => void;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const active = zone.status === 'active' && !zone.paused;
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as ZoneTab)}
      className="flex min-w-0 flex-col gap-2"
    >
      <div className={GLASS_CARD}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary shadow-[0_0_24px_-10px_hsl(var(--primary)/0.7)]">
            <Globe className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold tracking-tight text-foreground">
                {zone.name}
              </h2>
              <Chip tone={active ? 'success' : 'warning'} dot>
                {zoneStateText(zone)}
              </Chip>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {zone.plan || 'Cloudflare zone'}
            </p>
          </div>
          <ZoneQuickToggles zone={zone} />
        </div>
        {zone.status === 'pending' && (
          <div className="px-4 pb-3">
            <Notice tone="warning">
              Cloudflare is waiting for your registrar to use its name servers:{' '}
              <span className="font-mono">{zone.nameServers.join(', ')}</span>. Until then, changes
              here do not reach visitors.
            </Notice>
          </div>
        )}
        {/* Radix tabs, drawn as the kit's sliding pill, so arrow keys still move between them. */}
        <div className={cn(FOOTER_HAIRLINE, 'px-3 py-2')}>
          <LayoutGroup id="cloudflare-zone-tabs">
            <TabsList
              containerClassName="border-b-0"
              className="search-pill mb-0 h-auto w-auto max-w-full gap-0.5 rounded-full p-0.5"
            >
              {TABS.map((item) => {
                const selected = tab === item.value;
                return (
                  <TabsTrigger
                    key={item.value}
                    value={item.value}
                    className={cn(
                      'relative h-7 rounded-full border-b-0 px-3 text-xs focus-visible:ring-ring/60',
                      selected
                        ? 'text-primary data-[state=active]:text-primary'
                        : 'text-muted-foreground hover:bg-foreground/[0.06]',
                    )}
                  >
                    {selected && (
                      <motion.span
                        aria-hidden
                        layoutId="cloudflare-zone-tab-active"
                        transition={
                          reduceMotion
                            ? { duration: 0 }
                            : { type: 'spring', stiffness: 420, damping: 32 }
                        }
                        className="absolute inset-0 rounded-full bg-primary/12 ring-1 ring-inset ring-primary/20"
                      />
                    )}
                    <span className="relative">{item.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </LayoutGroup>
        </div>
      </div>
      <TabsContent value="dns" className={CONTENT}>
        <DnsRecordsCard zone={zone} />
      </TabsContent>
      <TabsContent value="ssl" className={CONTENT}>
        <SslTlsCard zone={zone} />
      </TabsContent>
      <TabsContent value="caching" className={CONTENT}>
        <CachingCard zone={zone} />
        <PurgeCard zone={zone} />
      </TabsContent>
      <TabsContent value="security" className={CONTENT}>
        <SecurityLevelCard zone={zone} />
        <CustomRulesCard zone={zone} />
        <AccessRulesCard zone={zone} />
      </TabsContent>
      <TabsContent value="servers" className={CONTENT}>
        <DnsTokensCard zone={zone} />
      </TabsContent>
      <TabsContent value="turnstile" className={CONTENT}>
        <TurnstileCard zone={zone} />
      </TabsContent>
    </Tabs>
  );
}
