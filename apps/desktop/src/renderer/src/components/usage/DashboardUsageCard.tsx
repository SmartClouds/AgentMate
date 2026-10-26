import { getUsageProvider, type ProviderUsage, type WidgetMode } from '@runova/core';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, X } from '@/components/icons';
import { Chip, TileHeader } from '@/components/pageKit';
import { ProviderLogo } from '@/components/providerLogos';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { UsageCardBody, UsageCardBodySkeleton } from '@/components/usage/UsageCard';

export interface DashboardUsageCardProps {
  providerId: string;
  /** Undefined until the scan lands, or when the provider is no longer tracked. */
  usage: ProviderUsage | undefined;
  /** Which view the Usage page card is showing; the dashboard mirrors it. */
  mode: WidgetMode;
  loading: boolean;
  /** Omitted outside the dashboard's edit mode, which hides the remove button. */
  onRemove?: () => void;
  /** The shared drag handle, so these cards reorder alongside the stat charts. */
  dragHandle?: React.ReactNode;
  /** The dashboard's glass card classes. */
  className?: string;
}

/**
 * A Token Usage provider card living on the dashboard. It's the same body the
 * Usage page and the desktop widgets render, only the surrounding chrome
 * differs (remove instead of pin, plus a shortcut back to the Usage page).
 */
export function DashboardUsageCard({
  providerId,
  usage,
  mode,
  loading,
  onRemove,
  dragHandle,
  className,
}: DashboardUsageCardProps): React.JSX.Element | null {
  const navigate = useNavigate();
  const def = getUsageProvider(providerId);
  if (!def) return null;

  return (
    <div className={className}>
      <div className="flex h-full flex-col p-4">
        <TileHeader
          className="mb-2"
          icon={<ProviderLogo providerId={providerId} className="h-5 w-5 shrink-0" />}
          iconClassName="text-foreground [&_svg]:size-5"
          title={def.name}
          extra={
            mode === 'subscription' && usage?.subscription?.plan ? (
              <Chip tone="primary">{usage.subscription.plan.label}</Chip>
            ) : null
          }
          actions={
            <>
              <SimpleTooltip label="Open Token Usage">
                <Button variant="ghost" size="icon-sm" onClick={() => navigate('/usage')}>
                  <ExternalLink />
                </Button>
              </SimpleTooltip>
              {dragHandle}
              {onRemove && (
                <SimpleTooltip label="Remove from dashboard">
                  <Button variant="ghost" size="icon-sm" onClick={onRemove}>
                    <X />
                  </Button>
                </SimpleTooltip>
              )}
            </>
          }
        />
        {usage ? (
          <UsageCardBody usage={usage} def={def} hideHeader mode={mode} />
        ) : loading ? (
          <UsageCardBodySkeleton />
        ) : (
          <div className="flex flex-1 items-center text-sm text-muted-foreground">
            No longer tracked on the Token Usage page.
          </div>
        )}
      </div>
    </div>
  );
}
