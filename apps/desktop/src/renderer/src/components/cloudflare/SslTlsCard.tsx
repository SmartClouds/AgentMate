import { sslAdvice } from '@shared/cloudflare/zone';
import type {
  CloudflareMinTlsVersion,
  CloudflareSslMode,
  CloudflareZone,
} from '@shared/cloudflareTypes';
import { motion, useReducedMotion } from 'framer-motion';
import { useId } from 'react';
import { Check, Lock, LockOpen, Monitor, Server } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Switch } from '@/components/ui/switch';
import { MIN_TLS_LABELS, MIN_TLS_VERSIONS, SSL_MODE_LABELS } from '@/lib/cloudflare/labels';
import { cn } from '@/lib/utils';
import { CloudflareMark } from './CloudflareMark';
import { CardBody, CloudflareCard, Notice, Problem, SettingRow, SettingsSkeleton } from './fields';
import { useZoneSettings } from './useZoneSettings';

type SettableMode = Exclude<CloudflareSslMode, 'origin_pull'>;

/** How safe one leg of the trip is: not encrypted, encrypted, or encrypted and checked. */
type Leg = 'open' | 'encrypted' | 'verified';

const MODES: { value: SettableMode; caption: string; legs: [Leg, Leg] }[] = [
  { value: 'off', caption: 'No HTTPS anywhere', legs: ['open', 'open'] },
  { value: 'flexible', caption: 'Encrypted to Cloudflare only', legs: ['encrypted', 'open'] },
  {
    value: 'full',
    caption: 'Encrypted, certificate not checked',
    legs: ['encrypted', 'encrypted'],
  },
  { value: 'strict', caption: 'Encrypted and checked', legs: ['encrypted', 'verified'] },
];

const LEG_TONES: Record<Leg, string> = {
  open: 'border-dashed border-muted-foreground/40 text-muted-foreground/70',
  encrypted: 'border-solid border-warning/60 text-warning',
  verified: 'border-solid border-success/70 text-success',
};

function PathLeg({ leg, label }: { leg: Leg; label: string }): React.JSX.Element {
  const Icon = leg === 'open' ? LockOpen : Lock;
  return (
    <span className="relative flex min-w-3 flex-1 items-center" title={label}>
      <span className={cn('h-0 w-full border-t-[1.5px]', LEG_TONES[leg])} />
      <span
        className={cn(
          'absolute left-1/2 top-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-card',
          LEG_TONES[leg],
        )}
      >
        <Icon className="h-2.5 w-2.5" />
      </span>
    </span>
  );
}

/** Visitor, Cloudflare and the server, with each leg between them drawn as it is protected. */
function TripPath({ legs }: { legs: [Leg, Leg] }): React.JSX.Element {
  const [front, back] = legs;
  return (
    <span aria-hidden className="flex w-full items-center gap-1 text-muted-foreground">
      <Monitor className="h-3 w-3 shrink-0" />
      {/* Visitors meet Cloudflare's own certificate, which is always trusted. */}
      <PathLeg leg={front === 'encrypted' ? 'verified' : front} label="Visitor to Cloudflare" />
      <CloudflareMark className="h-3.5 w-3.5" />
      <PathLeg leg={back} label="Cloudflare to your server" />
      <Server className="h-3 w-3 shrink-0" />
    </span>
  );
}

/** Moves focus between the mode cards. Picking one stays an explicit Enter, Space or click. */
function moveBetweenModes(event: React.KeyboardEvent<HTMLDivElement>): void {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const at = radios.indexOf(event.target as HTMLButtonElement);
  if (at === -1) return;
  event.preventDefault();
  radios[(at + step + radios.length) % radios.length]?.focus();
}

/**
 * The SSL/TLS tab (T3). The mode is four cards, each drawing the trip from the visitor through
 * Cloudflare to the server with a lock on every leg that is encrypted, so the difference between
 * Flexible and Full (strict) can be seen rather than looked up. Below sit the HTTPS redirects and
 * the TLS versions the zone accepts.
 */
export function SslTlsCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const id = useId();
  const reduceMotion = useReducedMotion();
  const { query, loadError, saving, change } = useZoneSettings(zone);

  let body: React.ReactNode;
  if (query.isPending) {
    body = <SettingsSkeleton rows={5} />;
  } else if (query.isError) {
    body = (
      <CardBody>
        <Problem message={loadError ?? ''} onRetry={() => void query.refetch()} />
      </CardBody>
    );
  } else {
    const { ssl, alwaysUseHttps, automaticHttpsRewrites, minTlsVersion, tls13 } = query.data;
    const advice = sslAdvice(ssl.value);
    const modeLocked = !ssl.editable || saving === 'ssl';
    const httpsOn = alwaysUseHttps.value === 'on';
    const rewritesOn = automaticHttpsRewrites.value === 'on';
    const tls13On = tls13.value !== 'off';
    const oldTls = minTlsVersion.value === '1.0' || minTlsVersion.value === '1.1';
    // With no card picked (origin pull), the first one still takes Tab.
    const focusable = MODES.some((mode) => mode.value === ssl.value) ? ssl.value : MODES[0].value;

    const pickMode = (value: SettableMode): void => {
      if (value === ssl.value) return;
      void change({ setting: 'ssl', value }, `SSL/TLS mode is ${SSL_MODE_LABELS[value]} now.`);
    };

    body = (
      <div className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
        <div className="space-y-3 px-4 py-3">
          <div>
            <p id={`${id}-mode`} className="text-sm font-medium text-foreground">
              Encryption mode
            </p>
            <p className="text-xs text-muted-foreground">
              How Cloudflare connects to your server for proxied records.
            </p>
          </div>
          <div
            role="radiogroup"
            aria-labelledby={`${id}-mode`}
            onKeyDown={moveBetweenModes}
            className="grid grid-cols-2 gap-2 xl:grid-cols-4"
          >
            {MODES.map((mode) => {
              const active = ssl.value === mode.value;
              return (
                <button
                  key={mode.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={SSL_MODE_LABELS[mode.value]}
                  tabIndex={mode.value === focusable ? 0 : -1}
                  disabled={modeLocked}
                  onClick={() => pickMode(mode.value)}
                  className={cn(
                    'group relative flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-xl px-3 py-2.5 text-left outline-none ring-1 ring-inset transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed',
                    active
                      ? 'ring-primary/40'
                      : 'ring-foreground/10 hover:bg-foreground/[0.04] hover:ring-foreground/20',
                    modeLocked && !active && 'opacity-60',
                  )}
                >
                  {active && (
                    <motion.span
                      aria-hidden
                      layoutId={`${id}-mode-active`}
                      transition={
                        reduceMotion
                          ? { duration: 0 }
                          : { type: 'spring', stiffness: 420, damping: 32 }
                      }
                      className="absolute inset-0 rounded-xl bg-primary/[0.07] shadow-[0_0_24px_-12px_hsl(var(--primary)/0.8)]"
                    />
                  )}
                  <span className="relative flex items-center gap-2">
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-[13px] font-medium',
                        active ? 'text-primary' : 'text-foreground',
                      )}
                    >
                      {SSL_MODE_LABELS[mode.value]}
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground ring-primary'
                          : 'ring-foreground/20',
                      )}
                    >
                      {active && <Check className="h-2.5 w-2.5" />}
                    </span>
                  </span>
                  <span className="relative">
                    <TripPath legs={mode.legs} />
                  </span>
                  <span className="relative text-[11px] leading-snug text-muted-foreground">
                    {mode.caption}
                  </span>
                </button>
              );
            })}
          </div>
          {ssl.value === 'origin_pull' && (
            <Notice size="sm">
              This zone uses {SSL_MODE_LABELS.origin_pull}, which only Cloudflare can set. Picking a
              mode above replaces it.
            </Notice>
          )}
          <Notice
            size="sm"
            tone={
              advice.level === 'ok' ? 'success' : advice.level === 'improve' ? 'neutral' : 'warning'
            }
            className="items-center"
            action={
              advice.recommended !== ssl.value &&
              ssl.editable && (
                <Button
                  size="sm"
                  variant="soft"
                  disabled={saving === 'ssl'}
                  onClick={() => pickMode('strict')}
                >
                  Use Full (strict)
                </Button>
              )
            }
          >
            {advice.message}
          </Notice>
        </div>
        <SettingRow
          title="Always Use HTTPS"
          titleId={`${id}-https`}
          description="Sends visitors who ask for http:// to the https:// address."
        >
          <Chip tone={httpsOn ? 'success' : 'neutral'}>{httpsOn ? 'On' : 'Off'}</Chip>
          <Switch
            checked={httpsOn}
            disabled={!alwaysUseHttps.editable || saving === 'alwaysUseHttps'}
            aria-labelledby={`${id}-https`}
            onCheckedChange={(checked) =>
              void change(
                { setting: 'alwaysUseHttps', value: checked ? 'on' : 'off' },
                checked ? 'Always Use HTTPS is on.' : 'Always Use HTTPS is off.',
              )
            }
          />
        </SettingRow>
        <SettingRow
          title="Automatic HTTPS Rewrites"
          titleId={`${id}-rewrites`}
          description="Fixes mixed content by loading http:// links on your pages over https://."
        >
          <Chip tone={rewritesOn ? 'success' : 'neutral'}>{rewritesOn ? 'On' : 'Off'}</Chip>
          <Switch
            checked={rewritesOn}
            disabled={!automaticHttpsRewrites.editable || saving === 'automaticHttpsRewrites'}
            aria-labelledby={`${id}-rewrites`}
            onCheckedChange={(checked) =>
              void change(
                { setting: 'automaticHttpsRewrites', value: checked ? 'on' : 'off' },
                checked ? 'Automatic HTTPS Rewrites is on.' : 'Automatic HTTPS Rewrites is off.',
              )
            }
          />
        </SettingRow>
        <SettingRow
          title="Minimum TLS version"
          htmlFor={`${id}-min-tls`}
          description="The oldest TLS version a visitor's browser may connect with."
          below={
            oldTls && (
              <Notice
                size="sm"
                className="items-center"
                action={
                  minTlsVersion.editable && (
                    <Button
                      size="sm"
                      variant="soft"
                      disabled={saving === 'minTlsVersion'}
                      onClick={() =>
                        void change(
                          { setting: 'minTlsVersion', value: '1.2' },
                          'Minimum TLS version is TLS 1.2 now.',
                        )
                      }
                    >
                      Use TLS 1.2
                    </Button>
                  )
                }
              >
                TLS 1.0 and 1.1 are outdated, and only old browsers and bots still need them. TLS
                1.2 is the usual minimum.
              </Notice>
            )
          }
        >
          <Combobox
            id={`${id}-min-tls`}
            className="w-36"
            searchable={false}
            options={MIN_TLS_VERSIONS.map((version) => ({
              value: version,
              label: MIN_TLS_LABELS[version],
            }))}
            value={minTlsVersion.value}
            disabled={!minTlsVersion.editable || saving === 'minTlsVersion'}
            onChange={(next) => {
              const value = next as CloudflareMinTlsVersion;
              void change(
                { setting: 'minTlsVersion', value },
                `Minimum TLS version is ${MIN_TLS_LABELS[value]} now.`,
              );
            }}
          />
        </SettingRow>
        <SettingRow
          title="TLS 1.3"
          titleId={`${id}-tls13`}
          description="The newest TLS version: faster to connect and drops older ciphers."
        >
          {tls13.value === 'zrt' && <Chip tone="primary">0-RTT</Chip>}
          <Chip tone={tls13On ? 'success' : 'neutral'}>{tls13On ? 'On' : 'Off'}</Chip>
          <Switch
            checked={tls13On}
            disabled={!tls13.editable || saving === 'tls13'}
            aria-labelledby={`${id}-tls13`}
            onCheckedChange={(checked) =>
              void change(
                { setting: 'tls13', value: checked ? 'on' : 'off' },
                checked ? 'TLS 1.3 is on.' : 'TLS 1.3 is off.',
              )
            }
          />
        </SettingRow>
      </div>
    );
  }

  return (
    <CloudflareCard
      icon={<Lock />}
      title="SSL/TLS"
      description={`How visitors and Cloudflare reach ${zone.name} over HTTPS.`}
    >
      {body}
    </CloudflareCard>
  );
}
