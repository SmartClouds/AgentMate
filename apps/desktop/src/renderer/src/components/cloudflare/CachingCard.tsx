import { BROWSER_CACHE_TTLS } from '@shared/cloudflare/zone';
import type { CloudflareZone } from '@shared/cloudflareTypes';
import { motion, useReducedMotion } from 'framer-motion';
import { useId } from 'react';
import { Clock } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Combobox } from '@/components/ui/combobox';
import { Switch } from '@/components/ui/switch';
import {
  browserCacheTtlLabel,
  CACHE_LEVEL_DESCRIPTIONS,
  CACHE_LEVEL_LABELS,
  CACHE_LEVELS,
  formatRemaining,
} from '@/lib/cloudflare/labels';
import { cn } from '@/lib/utils';
import { CardBody, CloudflareCard, Problem, SettingRow, SettingsSkeleton } from './fields';
import { useZoneSettings } from './useZoneSettings';

/**
 * How Cloudflare caches the zone (T3): development mode to skip the cache while a change goes out,
 * which addresses count as the same file, and how long browsers keep what they were sent.
 */
export function CachingCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const id = useId();
  const reduceMotion = useReducedMotion();
  const { query, loadError, saving, change } = useZoneSettings(zone);

  let body: React.ReactNode;
  if (query.isPending) {
    body = <SettingsSkeleton rows={3} />;
  } else if (query.isError) {
    body = (
      <CardBody>
        <Problem message={loadError ?? ''} onRetry={() => void query.refetch()} />
      </CardBody>
    );
  } else {
    const { developmentMode, cacheLevel, browserCacheTtl } = query.data;
    const developmentOn = developmentMode.value === 'on';
    const levelLocked = !cacheLevel.editable || saving === 'cacheLevel';
    // A value Cloudflare set that is not on the usual list still shows in words.
    const ttls = BROWSER_CACHE_TTLS.includes(browserCacheTtl.value)
      ? BROWSER_CACHE_TTLS
      : [...BROWSER_CACHE_TTLS, browserCacheTtl.value].sort((a, b) => a - b);
    body = (
      <div className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
        <SettingRow
          title="Development mode"
          titleId={`${id}-development`}
          description="Skips the cache for three hours, so changes to the site show at once."
        >
          <Chip tone={developmentOn ? 'warning' : 'neutral'}>
            {developmentOn ? `On, ${formatRemaining(developmentMode.secondsRemaining)}` : 'Off'}
          </Chip>
          <Switch
            checked={developmentOn}
            disabled={!developmentMode.editable || saving === 'developmentMode'}
            aria-labelledby={`${id}-development`}
            onCheckedChange={(checked) =>
              void change(
                { setting: 'developmentMode', value: checked ? 'on' : 'off' },
                checked ? 'Development mode is on for three hours.' : 'Development mode is off.',
              )
            }
          />
        </SettingRow>
        <SettingRow
          title="Caching level"
          titleId={`${id}-level`}
          description="Which addresses Cloudflare treats as the same cached file."
          below={
            <p className="text-xs text-muted-foreground">
              {CACHE_LEVEL_DESCRIPTIONS[cacheLevel.value]}
            </p>
          }
        >
          <div
            role="radiogroup"
            aria-labelledby={`${id}-level`}
            className="inline-flex flex-wrap items-center gap-0.5 rounded-full bg-foreground/[0.06] p-0.5"
          >
            {CACHE_LEVELS.map((level) => {
              const active = cacheLevel.value === level;
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={levelLocked}
                  onClick={() => {
                    if (active) return;
                    void change(
                      { setting: 'cacheLevel', value: level },
                      `Caching level is ${CACHE_LEVEL_LABELS[level]} now.`,
                    );
                  }}
                  className={cn(
                    'relative h-7 cursor-pointer rounded-full px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                    active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {active && (
                    <motion.span
                      aria-hidden
                      layoutId={`${id}-level-active`}
                      transition={
                        reduceMotion
                          ? { duration: 0 }
                          : { type: 'spring', stiffness: 420, damping: 32 }
                      }
                      className="absolute inset-0 rounded-full bg-background shadow-sm ring-1 ring-inset ring-primary/25"
                    />
                  )}
                  <span className="relative">{CACHE_LEVEL_LABELS[level]}</span>
                </button>
              );
            })}
          </div>
        </SettingRow>
        <SettingRow
          title="Browser cache TTL"
          htmlFor={`${id}-ttl`}
          description="How long a visitor's browser keeps files before it asks again."
        >
          <Combobox
            id={`${id}-ttl`}
            className="w-56"
            options={ttls.map((seconds) => ({
              value: String(seconds),
              label: browserCacheTtlLabel(seconds),
            }))}
            value={String(browserCacheTtl.value)}
            disabled={!browserCacheTtl.editable || saving === 'browserCacheTtl'}
            onChange={(next) => {
              const value = Number(next);
              void change(
                { setting: 'browserCacheTtl', value },
                value === 0
                  ? "Browsers follow your server's own cache headers now."
                  : `Browsers keep files for ${browserCacheTtlLabel(value)} now.`,
              );
            }}
          />
        </SettingRow>
      </div>
    );
  }

  return (
    <CloudflareCard
      icon={<Clock />}
      title="Caching"
      description={`How ${zone.name} is cached at Cloudflare and in browsers.`}
    >
      {body}
    </CloudflareCard>
  );
}
