import { sslAdvice } from '@shared/cloudflare/zone';
import type {
  CloudflareSecurityLevel,
  CloudflareSettingChange,
  CloudflareSslMode,
  CloudflareZone,
} from '@shared/cloudflareTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { SettingsIcon } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cloudflareFailureText, useCloudflareError } from '@/lib/cloudflare/feedback';
import { formatRemaining, SECURITY_LEVEL_LABELS, SSL_MODE_LABELS } from '@/lib/cloudflare/labels';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CardBody, CloudflareCard, Notice, Problem } from './fields';

const SECURITY_LEVELS = Object.keys(SECURITY_LEVEL_LABELS) as CloudflareSecurityLevel[];
const SETTABLE_SSL_MODES: Exclude<CloudflareSslMode, 'origin_pull'>[] = [
  'off',
  'flexible',
  'full',
  'strict',
];

function Row({
  title,
  titleId,
  htmlFor,
  description,
  children,
  below,
}: {
  title: string;
  titleId?: string;
  htmlFor?: string;
  description: string;
  children: React.ReactNode;
  below?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
              {title}
            </label>
          ) : (
            <p id={titleId} className="text-sm font-medium text-foreground">
              {title}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
      {below}
    </div>
  );
}

function SettingsSkeleton(): React.JSX.Element {
  return (
    <div className={cn(FOOTER_HAIRLINE, 'settings-rows')} aria-busy="true">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3.5">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-8 w-40 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * The zone settings an operator reaches for most (T3): development mode, the security level up to
 * "I'm Under Attack", the SSL/TLS mode with the suggestion for proxied domains, and Always Use
 * HTTPS. Every state is written out, not only shown by a switch's colour.
 */
export function ZoneSettingsCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const queryClient = useQueryClient();
  const id = useId();
  const key = queryKeys.cloudflareSettings(zone.id);
  const settings = useQuery({
    queryKey: key,
    queryFn: () => window.agentmat.cloudflare.zoneSettings(zone.id),
  });
  const loadError = useCloudflareError(settings.error);
  const [saving, setSaving] = useState<CloudflareSettingChange['setting'] | null>(null);

  async function change(next: CloudflareSettingChange, done: string): Promise<void> {
    setSaving(next.setting);
    try {
      queryClient.setQueryData(key, await window.agentmat.cloudflare.changeSetting(zone.id, next));
      toast.success(done);
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setSaving(null);
    }
  }

  let body: React.ReactNode;
  if (settings.isPending) {
    body = <SettingsSkeleton />;
  } else if (settings.isError) {
    body = (
      <CardBody>
        <Problem message={loadError ?? ''} onRetry={() => void settings.refetch()} />
      </CardBody>
    );
  } else {
    const { developmentMode, securityLevel, ssl, alwaysUseHttps } = settings.data;
    const advice = sslAdvice(ssl.value);
    const developmentOn = developmentMode.value === 'on';
    const httpsOn = alwaysUseHttps.value === 'on';
    body = (
      <div className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
        <Row
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
        </Row>
        <Row
          title="Security level"
          htmlFor={`${id}-security`}
          description="How suspicious a visitor has to look before Cloudflare checks them."
          below={
            securityLevel.value === 'under_attack' && (
              <Notice tone="warning" size="sm">
                I'm Under Attack is on: every visitor sees a short check before the site loads. Turn
                it back down once the attack is over.
              </Notice>
            )
          }
        >
          <Combobox
            id={`${id}-security`}
            className="w-48"
            searchable={false}
            options={SECURITY_LEVELS.map((level) => ({
              value: level,
              label: SECURITY_LEVEL_LABELS[level],
            }))}
            value={securityLevel.value}
            disabled={!securityLevel.editable || saving === 'securityLevel'}
            onChange={(next) => {
              const value = next as CloudflareSecurityLevel;
              void change(
                { setting: 'securityLevel', value },
                `Security level is ${SECURITY_LEVEL_LABELS[value]} now.`,
              );
            }}
          />
        </Row>
        <Row
          title="SSL/TLS mode"
          htmlFor={`${id}-ssl`}
          description="How Cloudflare connects to your server for proxied records."
          below={
            <Notice
              size="sm"
              tone={
                advice.level === 'ok'
                  ? 'success'
                  : advice.level === 'improve'
                    ? 'neutral'
                    : 'warning'
              }
              className="items-center"
              action={
                advice.recommended !== ssl.value &&
                ssl.editable && (
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={saving === 'ssl'}
                    onClick={() =>
                      void change(
                        { setting: 'ssl', value: 'strict' },
                        'SSL/TLS mode is Full (strict) now.',
                      )
                    }
                  >
                    Use Full (strict)
                  </Button>
                )
              }
            >
              {advice.message}
            </Notice>
          }
        >
          <Combobox
            id={`${id}-ssl`}
            className="w-48"
            searchable={false}
            options={[
              // Only Cloudflare can set this one, so it shows only while it is the value.
              ...(ssl.value === 'origin_pull'
                ? [{ value: 'origin_pull', label: SSL_MODE_LABELS.origin_pull }]
                : []),
              ...SETTABLE_SSL_MODES.map((mode) => ({ value: mode, label: SSL_MODE_LABELS[mode] })),
            ]}
            value={ssl.value}
            disabled={!ssl.editable || saving === 'ssl'}
            onChange={(next) => {
              const value = next as Exclude<CloudflareSslMode, 'origin_pull'>;
              void change(
                { setting: 'ssl', value },
                `SSL/TLS mode is ${SSL_MODE_LABELS[value]} now.`,
              );
            }}
          />
        </Row>
        <Row
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
        </Row>
      </div>
    );
  }

  return (
    <CloudflareCard
      icon={<SettingsIcon />}
      title="Settings"
      description={`For everything in ${zone.name}. Changes apply within seconds.`}
    >
      {body}
    </CloudflareCard>
  );
}
