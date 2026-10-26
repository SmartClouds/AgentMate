import type { CloudflareCustomRule, CloudflareZone } from '@shared/cloudflareTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Shield, Trash2 } from '@/components/icons';
import { Chip, type ChipTone, EmptyState, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cloudflareFailureText, useCloudflareError } from '@/lib/cloudflare/feedback';
import { ruleActionLabel } from '@/lib/cloudflare/labels';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { CardBody, CloudflareCard, Problem } from './fields';
import { RuleBuilderDialog } from './RuleBuilderDialog';

/** Block reads as danger, a challenge as caution, an allow as the safe one, and a log as neither. */
function actionTone(action: string): ChipTone {
  if (action === 'block') return 'destructive';
  if (action === 'skip') return 'success';
  if (action === 'log') return 'neutral';
  return 'warning';
}

function nameOf(rule: CloudflareCustomRule): string {
  return rule.description || 'this rule';
}

/**
 * The zone's WAF custom rules (T4), in the order Cloudflare runs them. Each can be switched off
 * without losing it; a delete asks first. New rules come from the builder.
 */
export function CustomRulesCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const queryClient = useQueryClient();
  const key = queryKeys.cloudflareCustomRules(zone.id);
  const rules = useQuery({
    queryKey: key,
    queryFn: () => window.runova.cloudflare.listCustomRules(zone.id),
  });
  const loadError = useCloudflareError(rules.error);
  const [building, setBuilding] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);

  async function setEnabled(rule: CloudflareCustomRule, enabled: boolean): Promise<void> {
    setChanging(rule.id);
    try {
      queryClient.setQueryData(
        key,
        await window.runova.cloudflare.setCustomRuleEnabled(zone.id, rule.id, enabled),
      );
      toast.success(`${rule.description || 'The rule'} is ${enabled ? 'on' : 'off'}.`);
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setChanging(null);
    }
  }

  async function remove(rule: CloudflareCustomRule): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete the rule ${nameOf(rule)}?`,
      description:
        'Requests it matched go through as if it was never there. To pause it instead, switch it off.',
      confirmLabel: 'Delete rule',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      queryClient.setQueryData(
        key,
        await window.runova.cloudflare.deleteCustomRule(zone.id, rule.id),
      );
      toast.success(`Deleted the rule ${nameOf(rule)}.`);
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    }
  }

  let body: React.ReactNode;
  if (rules.isPending) {
    body = (
      <div className={cn(FOOTER_HAIRLINE, 'settings-rows')} aria-busy="true">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-3/4" />
            </div>
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        ))}
      </div>
    );
  } else if (rules.isError) {
    body = (
      <CardBody>
        <Problem message={loadError ?? ''} onRetry={() => void rules.refetch()} />
      </CardBody>
    );
  } else if (rules.data.length === 0) {
    body = (
      <EmptyState
        size="sm"
        icon={Shield}
        title="No custom rules yet"
        description="Add one to block countries, challenge a login page or let your office through."
        className={FOOTER_HAIRLINE}
      />
    );
  } else {
    body = (
      <ul className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
        {rules.data.map((rule) => (
          <li key={rule.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-foreground">
                  {rule.description || 'No description'}
                </span>
                <Chip tone={actionTone(rule.action)}>{ruleActionLabel(rule.action)}</Chip>
              </p>
              <SimpleTooltip label={rule.expression.length > 60 ? rule.expression : null}>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {rule.expression}
                </p>
              </SimpleTooltip>
            </div>
            <span className="flex items-center gap-2">
              <span className="w-6 text-xs text-muted-foreground">
                {rule.enabled ? 'On' : 'Off'}
              </span>
              <Switch
                checked={rule.enabled}
                disabled={changing === rule.id}
                aria-label={nameOf(rule)}
                onCheckedChange={(checked) => void setEnabled(rule, checked)}
              />
              <SimpleTooltip label="Delete rule">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Delete the rule ${nameOf(rule)}`}
                  onClick={() => void remove(rule)}
                >
                  <Trash2 />
                </Button>
              </SimpleTooltip>
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <CloudflareCard
      icon={<Shield />}
      title="WAF custom rules"
      description="Cloudflare runs them top to bottom. An allow rule skips the ones below it."
      actions={
        <Button size="sm" onClick={() => setBuilding(true)}>
          <Plus className="h-3.5 w-3.5" /> Add rule
        </Button>
      }
    >
      {body}
      {building && <RuleBuilderDialog zone={zone} open onOpenChange={setBuilding} />}
    </CloudflareCard>
  );
}
