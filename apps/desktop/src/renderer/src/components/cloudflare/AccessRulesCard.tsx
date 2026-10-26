import { accessRuleTarget } from '@shared/cloudflare/rules';
import type {
  CloudflareAccessMode,
  CloudflareAccessRule,
  CloudflareZone,
} from '@shared/cloudflareTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Ban, Plus, Spinner, Trash2 } from '@/components/icons';
import { Chip, type ChipTone, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cloudflareFailureText, useCloudflareError } from '@/lib/cloudflare/feedback';
import { ACCESS_MODES, accessModeLabel, accessTargetLabel } from '@/lib/cloudflare/labels';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { CardBody, CloudflareCard, Field, Problem } from './fields';

/** Block reads as danger, a challenge as caution, and an allow as the safe one. */
const MODE_TONE: Record<CloudflareAccessMode, ChipTone> = {
  block: 'destructive',
  challenge: 'warning',
  js_challenge: 'warning',
  managed_challenge: 'warning',
  whitelist: 'success',
};

function article(word: string): string {
  return /^[AEIOU]/.test(word) ? 'an' : 'a';
}

/**
 * IP access rules (T4): block, challenge or allow one address, a range, a country or a network
 * (ASN) for the whole zone. What the value is read as shows while typing.
 */
export function AccessRulesCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const queryClient = useQueryClient();
  const id = useId();
  const key = queryKeys.cloudflareAccessRules(zone.id);
  const rules = useQuery({
    queryKey: key,
    queryFn: () => window.runova.cloudflare.listAccessRules(zone.id),
  });
  const loadError = useCloudflareError(rules.error);
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<CloudflareAccessMode>('block');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const target = value.trim() ? accessRuleTarget(value) : null;

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!target?.ok) return;
    setBusy(true);
    try {
      const created = await window.runova.cloudflare.createAccessRule(zone.id, {
        mode,
        value: value.trim(),
        notes: notes.trim(),
      });
      const label = accessModeLabel(mode);
      toast.success(`Added ${article(label)} ${label} rule for ${created.value}.`);
      setValue('');
      setNotes('');
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: CloudflareAccessRule): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete the rule for ${rule.value}?`,
      description: 'Requests from it are treated like any other again.',
      confirmLabel: 'Delete rule',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.cloudflare.deleteAccessRule(zone.id, rule.id);
      toast.success(`Deleted the rule for ${rule.value}.`);
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    }
  }

  let list: React.ReactNode;
  if (rules.isPending) {
    list = (
      <div className={cn(FOOTER_HAIRLINE, 'settings-rows')} aria-busy="true">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-5 w-14 rounded-full" />
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
    );
  } else if (rules.isError) {
    list = (
      <CardBody className="pt-4">
        <Problem message={loadError ?? ''} onRetry={() => void rules.refetch()} />
      </CardBody>
    );
  } else if (rules.data.length === 0) {
    list = (
      <p className={cn(FOOTER_HAIRLINE, 'px-4 py-3 text-sm text-muted-foreground')}>
        No IP access rules yet.
      </p>
    );
  } else {
    list = (
      <ul className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
        {rules.data.map((rule) => (
          <li key={rule.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
            <Chip tone={MODE_TONE[rule.mode] ?? 'neutral'}>{accessModeLabel(rule.mode)}</Chip>
            <span className="text-xs text-muted-foreground">{accessTargetLabel(rule.target)}</span>
            <span className="font-mono text-xs text-foreground">{rule.value}</span>
            {rule.notes && (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {rule.notes}
              </span>
            )}
            <SimpleTooltip label="Delete rule">
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-auto hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Delete the rule for ${rule.value}`}
                onClick={() => void remove(rule)}
              >
                <Trash2 />
              </Button>
            </SimpleTooltip>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <CloudflareCard
      icon={<Ban />}
      title="IP access rules"
      description={`Block, challenge or allow an address, a range, a country or a network for all of ${zone.name}.`}
    >
      <CardBody>
        <form onSubmit={(event) => void add(event)} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <Field
              label="Address, range, country or network"
              htmlFor={`${id}-value`}
              hint={target?.ok ? `Read as: ${accessTargetLabel(target.target)}` : undefined}
            >
              <Input
                id={`${id}-value`}
                value={value}
                placeholder="203.0.113.0/24, DE or AS13335"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
            <Field label="Action" htmlFor={`${id}-mode`}>
              <Combobox
                id={`${id}-mode`}
                searchable={false}
                options={ACCESS_MODES.map((candidate) => ({
                  value: candidate,
                  label: accessModeLabel(candidate),
                }))}
                value={mode}
                onChange={(next) => setMode(next as CloudflareAccessMode)}
              />
            </Field>
          </div>
          <Field label="Notes" htmlFor={`${id}-notes`}>
            <Input
              id={`${id}-notes`}
              value={notes}
              maxLength={500}
              placeholder="Why this rule exists"
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          {target && !target.ok && (
            <p role="alert" className="text-sm text-destructive">
              {target.problem}
            </p>
          )}
          <Button type="submit" size="sm" disabled={!target?.ok || busy}>
            {busy ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}{' '}
            Add access rule
          </Button>
        </form>
      </CardBody>
      {list}
    </CloudflareCard>
  );
}
