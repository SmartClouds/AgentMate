import type {
  RecaptchaChallenge,
  RecaptchaKey,
  RecaptchaKeyType,
  RecaptchaProjectRef,
} from '@shared/deployRecaptchaTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ChartSimple, ChevronDown, CircleCheck, EyeOff, Spinner } from '@/components/icons';
import { Notice, PillTabs } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
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
import { queryKeys } from '@/lib/queryKeys';
import { recaptchaFailureText } from '@/lib/recaptcha/feedback';
import { cn } from '@/lib/utils';
import { DomainChips } from './DomainChips';
import { IntegrationSnippets } from './IntegrationSnippets';
import { CHALLENGE_NAMES, CopyButton, SecretReveal } from './keyParts';
import { useSiteDomainSuggestions } from './useSiteDomainSuggestions';

export type KeyDialogMode =
  | { kind: 'create'; initial?: { name?: string; domains?: string[] } }
  | { kind: 'edit'; key: RecaptchaKey }
  | { kind: 'ready'; key: RecaptchaKey };

const TYPES: {
  value: RecaptchaKeyType;
  title: string;
  text: string;
  bestFor: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    value: 'score',
    title: 'Invisible score',
    text: 'No puzzle at all. Google scores each visit from 0 to 1 and your server decides.',
    bestFor: 'Best for sign-ups, contact forms and checkout.',
    icon: ChartSimple,
  },
  {
    value: 'checkbox',
    title: 'Checkbox',
    text: 'The familiar "I am not a robot" box, with a puzzle when Google is unsure.',
    bestFor: 'Best when people expect to prove they are human.',
    icon: CircleCheck,
  },
  {
    value: 'invisible',
    title: 'Invisible challenge',
    text: 'No box. A puzzle shows only when a visit looks suspicious.',
    bestFor: 'Best for a clean form that still stops bots.',
    icon: EyeOff,
  },
];

const SUGGESTIONS_SHOWN = 8;

/** The three ways a key can check people, as large cards. The type of an existing key is locked. */
function TypeCards({
  value,
  onChange,
  locked,
}: {
  value: RecaptchaKeyType;
  onChange: (type: RecaptchaKeyType) => void;
  locked: boolean;
}): React.JSX.Element {
  const name = useId();
  return (
    <div role="radiogroup" aria-label="Key type" className="grid gap-2 sm:grid-cols-3">
      {TYPES.map((type) => {
        const checked = type.value === value;
        const Icon = type.icon;
        return (
          <label
            key={type.value}
            className={cn(
              'relative flex cursor-pointer flex-col gap-1.5 rounded-xl p-3 ring-1 ring-inset transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              checked
                ? 'bg-primary/10 ring-primary/40'
                : 'bg-foreground/[0.03] ring-foreground/[0.08] hover:bg-foreground/[0.06]',
              locked && !checked && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="radio"
              name={name}
              value={type.value}
              checked={checked}
              disabled={locked && !checked}
              onChange={() => onChange(type.value)}
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
              <span className="text-sm font-medium text-foreground">{type.title}</span>
            </span>
            {type.value === 'score' && (
              <span className="absolute right-2 top-2 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                Recommended
              </span>
            )}
            <span className="text-xs text-muted-foreground">{type.text}</span>
            <span className="text-[11px] text-foreground/70">{type.bestFor}</span>
          </label>
        );
      })}
    </div>
  );
}

function KeyForm({
  mode,
  project,
  onCreated,
  onClose,
}: {
  mode: Extract<KeyDialogMode, { kind: 'create' | 'edit' }>;
  project: RecaptchaProjectRef;
  onCreated: (key: RecaptchaKey) => void;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const editing = mode.kind === 'edit' ? mode.key : null;
  const initial = mode.kind === 'create' ? mode.initial : undefined;
  const nameId = useId();
  const domainsId = useId();
  const suggestions = useSiteDomainSuggestions();
  const [name, setName] = useState(editing?.name ?? initial?.name ?? '');
  const [domains, setDomains] = useState<string[]>(editing?.domains ?? initial?.domains ?? []);
  const [type, setType] = useState<RecaptchaKeyType>(editing?.type ?? 'score');
  const [challenge, setChallenge] = useState<RecaptchaChallenge | null>(editing?.challenge ?? null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [allSuggestions, setAllSuggestions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const challenges = type !== 'score';
  const ready = name.trim().length > 0 && domains.length > 0 && !busy;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    const picked = challenges && challenge ? { challenge } : {};
    try {
      if (editing) {
        await window.runova.deployRecaptcha.updateKey(
          { ...project, keyId: editing.id },
          editing.type,
          { name: name.trim(), domains, ...picked },
        );
        toast.success(`Saved ${name.trim()}.`);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.recaptchaKeys(project.accountId, project.projectId),
        });
        onClose();
      } else {
        const created = await window.runova.deployRecaptcha.createKey(project, {
          name: name.trim(),
          type,
          domains,
          ...picked,
        });
        toast.success(`Created the key for ${created.name}.`);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.recaptchaKeys(project.accountId, project.projectId),
        });
        onCreated(created);
      }
    } catch (error) {
      setProblem(recaptchaFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  const shownSuggestions = allSuggestions ? suggestions : suggestions.slice(0, SUGGESTIONS_SHOWN);

  return (
    <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${editing.name}` : 'New reCAPTCHA key'}</DialogTitle>
        <DialogDescription>
          {editing
            ? 'Change where the key works. Sites that use it keep working while you save.'
            : 'A key works on the domains you list. You get the site key, the secret and the code to paste once it is made.'}
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
        {!editing && suggestions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Start from one of your sites
            </p>
            <div className="flex flex-wrap gap-1.5">
              {shownSuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  aria-label={`Use ${suggestion.label}`}
                  onClick={() => {
                    setName(suggestion.label);
                    setDomains(suggestion.domains);
                  }}
                  className="h-7 rounded-full bg-foreground/[0.05] px-3 text-xs text-foreground outline-none ring-1 ring-inset ring-foreground/[0.08] transition-colors hover:bg-primary/10 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {suggestion.label}
                </button>
              ))}
              {!allSuggestions && suggestions.length > SUGGESTIONS_SHOWN && (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  onClick={() => setAllSuggestions(true)}
                >
                  Show all {suggestions.length}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            value={name}
            maxLength={100}
            placeholder="My shop"
            onChange={(event) => setName(event.target.value)}
            autoFocus={!initial?.name}
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium leading-none">How it checks people</p>
          <TypeCards value={type} onChange={setType} locked={editing !== null} />
          {editing && (
            <p className="text-xs text-muted-foreground">
              A key's type cannot change. Make a new key for another type.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={domainsId}>Domains</Label>
          <DomainChips id={domainsId} domains={domains} onChange={setDomains} />
        </div>

        {challenges && (
          <div className="space-y-2">
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-3 [&_svg]:w-3"
            >
              <ChevronDown className={cn('transition-transform', moreOpen && 'rotate-180')} /> More
              options
            </button>
            {moreOpen && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/[0.06]">
                <div>
                  <p className="text-sm font-medium">Challenge difficulty</p>
                  <p className="text-xs text-muted-foreground">
                    Harder stops more bots, easier bothers fewer people.
                  </p>
                </div>
                <PillTabs
                  id={`${domainsId}-challenge`}
                  label="Challenge difficulty"
                  kind="toggle"
                  size="xs"
                  items={(['usability', 'balance', 'security'] as const).map((value) => ({
                    value,
                    label: CHALLENGE_NAMES[value],
                  }))}
                  value={challenge ?? 'balance'}
                  onChange={setChallenge}
                />
              </div>
            )}
          </div>
        )}

        {problem && <Notice tone="destructive">{problem}</Notice>}
      </div>

      <DialogFooter>
        <Button type="button" variant="soft" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          {editing ? (busy ? 'Saving' : 'Save changes') : busy ? 'Creating' : 'Create key'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The site key, the secret and the code to paste, for a key just made or one in the list. */
function ReadyPanel({
  keyItem,
  project,
  fresh,
  onDone,
}: {
  keyItem: RecaptchaKey;
  project: RecaptchaProjectRef;
  fresh: boolean;
  onDone: () => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          {fresh ? 'Your key is ready' : `Add ${keyItem.name} to your site`}
        </DialogTitle>
        <DialogDescription>
          The site key goes in your page. The secret stays on your server, where it checks each
          token with Google.
        </DialogDescription>
      </DialogHeader>
      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
        <dl className="divide-y divide-foreground/[0.06] rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.06]">
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Site key</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <code className="truncate font-mono text-xs">{keyItem.id}</code>
              <CopyButton text={keyItem.id} label="Copy site key" />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Secret</dt>
            <dd className="min-w-0">
              <SecretReveal keyRef={{ ...project, keyId: keyItem.id }} autoFetch={fresh} />
            </dd>
          </div>
        </dl>
        <IntegrationSnippets siteKey={keyItem.id} type={keyItem.type} />
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
 * Making or editing a key, in one screen with smart defaults, and the "add it to your site" panel
 * that follows. A key just made opens straight on its site key, secret and code.
 */
export function KeyDialog({
  open,
  mode,
  project,
  onOpenChange,
}: {
  open: boolean;
  mode: KeyDialogMode;
  project: RecaptchaProjectRef;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [created, setCreated] = useState<RecaptchaKey | null>(null);
  const close = () => onOpenChange(false);
  const ready = created ?? (mode.kind === 'ready' ? mode.key : null);

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
          <ReadyPanel keyItem={ready} project={project} fresh={created !== null} onDone={close} />
        ) : mode.kind !== 'ready' ? (
          <KeyForm mode={mode} project={project} onCreated={setCreated} onClose={close} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
