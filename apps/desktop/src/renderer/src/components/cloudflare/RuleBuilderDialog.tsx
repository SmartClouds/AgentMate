import { buildRule, describeRule } from '@shared/cloudflare/rules';
import type { CloudflareRuleSpec, CloudflareZone } from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { ruleActionLabel, splitList } from '@/lib/cloudflare/labels';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { Field } from './fields';

type Kind = CloudflareRuleSpec['kind'];

const KINDS: Array<{ kind: Kind; label: string; description: string }> = [
  {
    kind: 'block-countries',
    label: 'Block countries',
    description: 'Visitors from these countries get an error page.',
  },
  {
    kind: 'challenge-path',
    label: 'Challenge a path',
    description: 'Visitors to a page, such as a login, prove they are human first.',
  },
  {
    kind: 'allow-ips',
    label: 'Allow IP addresses',
    description: 'Requests from these addresses skip the other custom rules.',
  },
];

/**
 * Builds a WAF custom rule from a few plain choices and shows the expression Cloudflare will run,
 * so nothing is added that the user has not seen. Every value is checked as it is typed; the
 * main process checks it again before it reaches Cloudflare.
 */
export function RuleBuilderDialog({
  zone,
  open,
  onOpenChange,
}: {
  zone: CloudflareZone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const id = useId();
  const [kind, setKind] = useState<Kind>('block-countries');
  const [countries, setCountries] = useState('');
  const [path, setPath] = useState('');
  const [match, setMatch] = useState<'exact' | 'prefix'>('exact');
  const [ips, setIps] = useState('');
  const [description, setDescription] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  let spec: CloudflareRuleSpec;
  let filledIn: boolean;
  if (kind === 'block-countries') {
    spec = { kind, countries: splitList(countries) };
    filledIn = countries.trim() !== '';
  } else if (kind === 'challenge-path') {
    spec = { kind, path: path.trim(), match };
    filledIn = path.trim() !== '';
  } else {
    spec = { kind, ips: splitList(ips) };
    filledIn = ips.trim() !== '';
  }
  const built = buildRule(spec);
  const text = description ?? (filledIn ? describeRule(spec) : '');

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!built.ok || text.trim() === '') return;
    setBusy(true);
    setProblem(null);
    try {
      const rules = await window.runova.cloudflare.createCustomRule(zone.id, {
        description: text.trim(),
        spec,
      });
      queryClient.setQueryData(queryKeys.cloudflareCustomRules(zone.id), rules);
      toast.success(`Added the rule ${text.trim()}.`);
      onOpenChange(false);
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setProblem(null);
    };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form
          onSubmit={(event) => void add(event)}
          className="flex max-h-[calc(85vh-3rem)] min-h-0 flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Add a custom rule</DialogTitle>
            <DialogDescription>
              Custom rules run for every request to {zone.name}, before it reaches your server.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
            <fieldset className="grid gap-2 sm:grid-cols-3">
              <legend className="sr-only">Rule</legend>
              {KINDS.map((option) => (
                <label
                  key={option.kind}
                  className={cn(
                    // Ring edges, because the global border colour would repaint a tinted border.
                    'flex cursor-pointer flex-col gap-1 rounded-xl px-3 py-2 ring-1 ring-inset transition-colors focus-within:ring-2 focus-within:ring-ring',
                    kind === option.kind
                      ? 'bg-primary/10 ring-primary/40'
                      : 'bg-foreground/[0.03] ring-foreground/[0.08] hover:bg-foreground/[0.06]',
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="radio"
                      name={`${id}-kind`}
                      value={option.kind}
                      aria-label={option.label}
                      aria-describedby={`${id}-${option.kind}`}
                      checked={kind === option.kind}
                      onChange={() => {
                        changed(setKind)(option.kind);
                        setDescription(null);
                      }}
                      className="accent-primary"
                    />
                    {option.label}
                  </span>
                  <span id={`${id}-${option.kind}`} className="text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </label>
              ))}
            </fieldset>

            {kind === 'block-countries' && (
              <Field
                label="Country codes"
                htmlFor={`${id}-countries`}
                hint="Two-letter codes, separated by commas, such as CN, RU. T1 stands for Tor."
              >
                <Input
                  id={`${id}-countries`}
                  value={countries}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => changed(setCountries)(event.target.value)}
                />
              </Field>
            )}
            {kind === 'challenge-path' && (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
                <Field label="Path" htmlFor={`${id}-path`}>
                  <Input
                    id={`${id}-path`}
                    value={path}
                    placeholder="/wp-login.php"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    onChange={(event) => changed(setPath)(event.target.value)}
                  />
                </Field>
                <Field label="Match" htmlFor={`${id}-match`}>
                  <Combobox
                    id={`${id}-match`}
                    searchable={false}
                    options={[
                      { value: 'exact', label: 'Exactly this path' },
                      { value: 'prefix', label: 'This path and everything under it' },
                    ]}
                    value={match}
                    onChange={(next) => changed(setMatch)(next as 'exact' | 'prefix')}
                  />
                </Field>
              </div>
            )}
            {kind === 'allow-ips' && (
              <Field
                label="Addresses and ranges"
                htmlFor={`${id}-ips`}
                hint="One per line, or separated by commas, such as 203.0.113.10 or 2001:db8::/32."
              >
                <Textarea
                  id={`${id}-ips`}
                  value={ips}
                  rows={3}
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) => changed(setIps)(event.target.value)}
                />
              </Field>
            )}

            <Field label="Description" htmlFor={`${id}-description`}>
              <Input
                id={`${id}-description`}
                value={text}
                maxLength={500}
                onChange={(event) => changed(setDescription)(event.target.value)}
              />
            </Field>

            <div className="space-y-1.5 rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/[0.08]">
              <p className="text-xs font-medium text-muted-foreground">What Cloudflare will run</p>
              {built.ok ? (
                <>
                  <pre
                    aria-label="Expression"
                    className="whitespace-pre-wrap break-all font-mono text-xs text-foreground"
                  >
                    {built.rule.expression}
                  </pre>
                  <p className="text-xs text-foreground">
                    Action: {ruleActionLabel(built.rule.action)}
                  </p>
                  {built.rule.first && (
                    <p className="text-xs text-muted-foreground">
                      This rule goes first, so the rules after it never see these addresses.
                    </p>
                  )}
                </>
              ) : filledIn ? (
                <p role="alert" className="text-xs text-destructive">
                  {built.problem}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Fill in the rule to see its expression.
                </p>
              )}
            </div>
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!built.ok || text.trim() === '' || busy}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Add rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
