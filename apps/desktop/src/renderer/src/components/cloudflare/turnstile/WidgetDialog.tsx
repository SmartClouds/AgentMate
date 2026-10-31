import {
  MAX_TURNSTILE_DOMAINS,
  MAX_TURNSTILE_NAME,
  TURNSTILE_CLEARANCES,
} from '@shared/cloudflare/turnstile';
import type {
  CloudflareZone,
  TurnstileClearance,
  TurnstileMode,
  TurnstileRegion,
  TurnstileWidget,
  TurnstileWidgetInput,
} from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, EyeOff, Robot, ShieldSolid, Spinner } from '@/components/icons';
import { Chip, Notice, PillTabs } from '@/components/pageKit';
import { DomainChips } from '@/components/recaptcha/DomainChips';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { TestKeysHint } from './TestKeysHint';
import { TurnstileSnippets } from './TurnstileSnippets';
import { CLEARANCE_NAMES, TurnstileSecret } from './widgetParts';

export type WidgetDialogMode =
  | { kind: 'create' }
  | { kind: 'edit'; widget: TurnstileWidget }
  | { kind: 'ready'; widget: TurnstileWidget };

const MODES: {
  value: TurnstileMode;
  title: string;
  text: string;
  bestFor: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    value: 'managed',
    title: 'Managed',
    text: 'Most visitors only see a short check. A checkbox shows when a visit looks off.',
    bestFor: 'Best for most forms.',
    icon: ShieldSolid,
  },
  {
    value: 'non-interactive',
    title: 'Non-interactive',
    text: 'The widget shows while it checks, but never asks anyone to click.',
    bestFor: 'Best when a visible sign of protection helps.',
    icon: Robot,
  },
  {
    value: 'invisible',
    title: 'Invisible',
    text: 'Nothing shows at all. The check runs in the background.',
    bestFor: 'Best for a clean design.',
    icon: EyeOff,
  },
];

const DEFAULTS = {
  clearance: 'no_clearance' as TurnstileClearance,
  region: 'world' as TurnstileRegion,
  offlabel: false,
  ephemeralId: false,
};

/** The three ways a widget can check people, as large cards; arrow keys move between them. */
function ModeCards({
  value,
  onChange,
}: {
  value: TurnstileMode;
  onChange: (mode: TurnstileMode) => void;
}): React.JSX.Element {
  const name = useId();
  return (
    <div role="radiogroup" aria-label="Widget mode" className="grid gap-2 sm:grid-cols-3">
      {MODES.map((mode) => {
        const checked = mode.value === value;
        const Icon = mode.icon;
        return (
          <label
            key={mode.value}
            className={cn(
              'flex cursor-pointer flex-col gap-1.5 rounded-xl p-3 ring-1 ring-inset transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              checked
                ? 'bg-primary/10 ring-primary/40'
                : 'bg-foreground/[0.03] ring-foreground/[0.08] hover:bg-foreground/[0.06]',
            )}
          >
            <input
              type="radio"
              name={name}
              value={mode.value}
              checked={checked}
              onChange={() => onChange(mode.value)}
              className="sr-only"
            />
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-lg',
                  checked
                    ? 'bg-primary/15 text-primary'
                    : 'bg-foreground/[0.06] text-foreground/70',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="text-sm font-medium text-foreground">{mode.title}</span>
              {mode.value === 'managed' && (
                <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                  Recommended
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">{mode.text}</span>
            <span className="text-[11px] text-foreground/70">{mode.bestFor}</span>
          </label>
        );
      })}
    </div>
  );
}

/** One advanced option: its name, an Enterprise chip when it needs that plan, and the control. */
function AdvancedRow({
  title,
  titleId,
  description,
  enterprise,
  children,
}: {
  title: string;
  titleId?: string;
  description: string;
  enterprise?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p id={titleId} className="flex items-center gap-2 text-sm font-medium">
          {title}
          {enterprise && <Chip>Enterprise</Chip>}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function WidgetForm({
  zone,
  editing,
  onCreated,
  onClose,
}: {
  zone: CloudflareZone;
  editing: TurnstileWidget | null;
  onCreated: (widget: TurnstileWidget) => void;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const nameId = useId();
  const domainsId = useId();
  const advancedId = useId();
  const [name, setName] = useState(editing?.name ?? zone.name);
  const [domains, setDomains] = useState<string[]>(editing?.domains ?? [zone.name]);
  const [mode, setMode] = useState<TurnstileMode>(editing?.mode ?? 'managed');
  const [clearance, setClearance] = useState(editing?.clearance ?? DEFAULTS.clearance);
  const [region, setRegion] = useState(editing?.region ?? DEFAULTS.region);
  const [offlabel, setOfflabel] = useState(editing?.offlabel ?? DEFAULTS.offlabel);
  const [ephemeralId, setEphemeralId] = useState(editing?.ephemeralId ?? DEFAULTS.ephemeralId);
  // An edited widget with something set under Advanced opens there, so nothing is hidden.
  const [advancedOpen, setAdvancedOpen] = useState(
    editing !== null &&
      (editing.clearance !== DEFAULTS.clearance ||
        editing.region !== DEFAULTS.region ||
        editing.offlabel ||
        editing.ephemeralId),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = name.trim().length > 0 && domains.length > 0 && !busy;
  const listKey = queryKeys.cloudflareTurnstile(zone.cloudflareAccountId);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    const input: TurnstileWidgetInput = {
      name: name.trim(),
      domains,
      mode,
      clearance,
      region,
      offlabel,
      ephemeralId,
    };
    try {
      if (editing) {
        await window.runova.cloudflare.updateTurnstileWidget(zone.id, editing.sitekey, input);
        toast.success(`Saved ${input.name}.`);
        await queryClient.invalidateQueries({ queryKey: listKey });
        onClose();
      } else {
        const created = await window.runova.cloudflare.createTurnstileWidget(zone.id, input);
        // Cloudflare hands the secret back once here; keep it so the next step need not ask.
        queryClient.setQueryData(
          queryKeys.cloudflareTurnstileSecret(zone.cloudflareAccountId, created.widget.sitekey),
          created.secret,
        );
        toast.success(`Created the ${created.widget.name} widget.`);
        void queryClient.invalidateQueries({ queryKey: listKey });
        onCreated(created.widget);
      }
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${editing.name}` : 'New Turnstile widget'}</DialogTitle>
        <DialogDescription>
          {editing
            ? 'Forms that use this widget keep working while you save. The site key stays the same.'
            : 'A widget works on the domains you list. You get the site key, the secret and the code to paste once it is made.'}
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
        <div className="space-y-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            value={name}
            maxLength={MAX_TURNSTILE_NAME}
            placeholder="Contact form"
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium leading-none">How it checks people</p>
          <ModeCards value={mode} onChange={setMode} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={domainsId}>Domains</Label>
          <DomainChips
            id={domainsId}
            domains={domains}
            onChange={setDomains}
            max={MAX_TURNSTILE_DOMAINS}
            localhostSwitch={false}
          />
        </div>

        <div className="space-y-2">
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls={advancedId}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-3 [&_svg]:w-3"
          >
            <ChevronDown className={cn('transition-transform', advancedOpen && 'rotate-180')} />
            Advanced
          </button>
          {advancedOpen && (
            <div
              id={advancedId}
              className="divide-y divide-foreground/[0.06] rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.06]"
            >
              <AdvancedRow
                title="Pre-clearance"
                description="A solved widget also lets the visitor past Cloudflare challenges of this level on your site."
              >
                <PillTabs
                  id={`${advancedId}-clearance`}
                  label="Pre-clearance"
                  kind="toggle"
                  size="xs"
                  items={TURNSTILE_CLEARANCES.map((value) => ({
                    value,
                    label: CLEARANCE_NAMES[value],
                  }))}
                  value={clearance}
                  onChange={setClearance}
                />
              </AdvancedRow>
              <AdvancedRow
                title="Region"
                description="China runs the check from inside mainland China, for visitors there."
                enterprise
              >
                <PillTabs
                  id={`${advancedId}-region`}
                  label="Region"
                  kind="toggle"
                  size="xs"
                  items={[
                    { value: 'world', label: 'Worldwide' },
                    { value: 'china', label: 'China' },
                  ]}
                  value={region}
                  onChange={setRegion}
                />
              </AdvancedRow>
              <AdvancedRow
                title="Hide Cloudflare branding"
                description="The widget shows without the Cloudflare logo."
                enterprise
              >
                <Switch
                  aria-label="Hide Cloudflare branding"
                  checked={offlabel}
                  onCheckedChange={setOfflabel}
                />
              </AdvancedRow>
              <AdvancedRow
                title="Ephemeral IDs"
                description="Each check result carries a short-lived visitor id, to spot one bot across many IPs."
                enterprise
              >
                <Switch
                  aria-label="Ephemeral IDs"
                  checked={ephemeralId}
                  onCheckedChange={setEphemeralId}
                />
              </AdvancedRow>
            </div>
          )}
        </div>

        {problem && <Notice tone="destructive">{problem}</Notice>}
      </div>

      <DialogFooter>
        <Button type="button" variant="soft" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          {editing ? (busy ? 'Saving' : 'Save changes') : busy ? 'Creating' : 'Create widget'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The site key, the secret and the code to paste, for a widget just made or one in the list. */
function ReadyPanel({
  zone,
  widget,
  fresh,
  onDone,
}: {
  zone: CloudflareZone;
  widget: TurnstileWidget;
  fresh: boolean;
  onDone: () => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          {fresh ? 'Your widget is ready' : `Add ${widget.name} to your site`}
        </DialogTitle>
        <DialogDescription>
          The site key goes in your page. The secret stays on your server, where it checks each
          token with Cloudflare.
        </DialogDescription>
      </DialogHeader>
      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
        <dl className="divide-y divide-foreground/[0.06] rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.06]">
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Site key</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <code className="truncate font-mono text-xs">{widget.sitekey}</code>
              <CopyButton text={widget.sitekey} label="Copy site key" alwaysVisible />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Secret</dt>
            <dd className="min-w-0">
              <TurnstileSecret zone={zone} sitekey={widget.sitekey} autoFetch={fresh} />
            </dd>
          </div>
        </dl>
        <TurnstileSnippets siteKey={widget.sitekey} />
        <TestKeysHint />
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Making or editing a Turnstile widget in one screen, started from the zone, and the "add it to
 * your site" panel that follows. A widget just made opens straight on its keys and code.
 */
export function WidgetDialog({
  open,
  zone,
  mode,
  onOpenChange,
}: {
  open: boolean;
  zone: CloudflareZone;
  mode: WidgetDialogMode;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [created, setCreated] = useState<TurnstileWidget | null>(null);
  const close = () => onOpenChange(false);
  const ready = created ?? (mode.kind === 'ready' ? mode.widget : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setCreated(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        {ready ? (
          <ReadyPanel zone={zone} widget={ready} fresh={created !== null} onDone={close} />
        ) : (
          <WidgetForm
            zone={zone}
            editing={mode.kind === 'edit' ? mode.widget : null}
            onCreated={setCreated}
            onClose={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
