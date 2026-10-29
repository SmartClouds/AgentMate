import type { CloudflareSecurityLevel, CloudflareZone } from '@shared/cloudflareTypes';
import { useId } from 'react';
import { Shield } from '@/components/icons';
import { FOOTER_HAIRLINE } from '@/components/pageKit';
import { Combobox } from '@/components/ui/combobox';
import { SECURITY_LEVEL_LABELS } from '@/lib/cloudflare/labels';
import { cn } from '@/lib/utils';
import { CardBody, CloudflareCard, Notice, Problem, SettingRow, SettingsSkeleton } from './fields';
import { useZoneSettings } from './useZoneSettings';

const SECURITY_LEVELS = Object.keys(SECURITY_LEVEL_LABELS) as CloudflareSecurityLevel[];

/**
 * How suspicious a visitor has to look before Cloudflare checks them, up to "I'm Under Attack".
 * While that is on, the card says so and asks for it to be turned back down afterwards.
 */
export function SecurityLevelCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const id = useId();
  const { query, loadError, saving, change } = useZoneSettings(zone);

  let body: React.ReactNode;
  if (query.isPending) {
    body = <SettingsSkeleton rows={1} />;
  } else if (query.isError) {
    body = (
      <CardBody>
        <Problem message={loadError ?? ''} onRetry={() => void query.refetch()} />
      </CardBody>
    );
  } else {
    const { securityLevel } = query.data;
    body = (
      <div className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
        <SettingRow
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
        </SettingRow>
      </div>
    );
  }

  return (
    <CloudflareCard
      icon={<Shield />}
      title="Protection"
      description={`Who gets a check before reaching ${zone.name}.`}
    >
      {body}
    </CloudflareCard>
  );
}
