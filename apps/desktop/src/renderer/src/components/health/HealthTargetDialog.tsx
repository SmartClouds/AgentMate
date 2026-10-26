import {
  formatHealthInterval,
  HEALTH_DEFAULT_PATH,
  HEALTH_INTERVAL_PRESETS,
  type HealthAuthMode,
  type Project,
} from '@runova/core';
import type { HealthSecretReveal, HealthTargetSummary } from '@shared/healthTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { HeartPulse, Pencil, Server, Sparkles, Spinner } from '@/components/icons';
import {
  FOOTER_HAIRLINE,
  Notice,
  Problem,
  SEGMENT_TRACK,
  segmentClass,
} from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { WordPressMark } from '@/components/wordpress/WordPressMark';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { described, Field, FormSection } from './formParts';
import { HealthSecretStep } from './HealthSecretStep';
import {
  emptyHealthDraft,
  type HealthDraft,
  type HealthDraftErrors,
  healthDraftFromTarget,
  healthDraftToInput,
  type IntervalChoice,
  isInsecureRemote,
  validateHealthDraft,
} from './healthView';
import { useHealthActions } from './useHealth';

/**
 * Adds a health check, or edits one. Adding ends on the one-time key step: the key comes back
 * from the main process once, sits in this dialog's state while the step is up, and is dropped
 * as soon as the dialog closes.
 */

const QUIET = { silentLoading: true } as const;

const AUTH_OPTIONS: { mode: HealthAuthMode; title: string; badge?: string; body: string }[] = [
  {
    mode: 'bearer',
    title: 'Bearer key',
    badge: 'Recommended',
    body: 'A long random key in the Authorization header. Nothing to remember.',
  },
  {
    mode: 'basic',
    title: 'HTTP Basic',
    body: 'A username and a generated password, for hosts that already sit behind Basic.',
  },
];

function SwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-description`} className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={`${id}-description`}
      />
    </div>
  );
}

type Step = { kind: 'form' } | { kind: 'secret'; reveal: HealthSecretReveal; targetId: string };

export function HealthTargetDialog({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  lockProject = false,
  target,
  onConnect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly Project[];
  defaultProjectId?: string;
  /** On a project's own tab the project is a given. */
  lockProject?: boolean;
  /** Set to edit this target; left out to add one. */
  target?: HealthTargetSummary;
  /** Offered after the key step, to go straight on to the setup prompt. */
  onConnect?: (targetId: string) => void;
}): React.JSX.Element {
  const editing = target !== undefined;
  const ids = useId();
  const id = (name: string) => `${ids}-${name}`;
  const actions = useHealthActions();
  const initial = (): HealthDraft =>
    target
      ? healthDraftFromTarget(target)
      : emptyHealthDraft(defaultProjectId ?? (projects.length === 1 ? projects[0].id : ''));
  const [draft, setDraft] = useState<HealthDraft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'form' });

  // Every opening starts from the target (or a blank form), never from the last visit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens
  useEffect(() => {
    if (!open) return;
    setDraft(initial());
    setSubmitted(false);
    setProblem(null);
    setStep({ kind: 'form' });
  }, [open, target?.id]);

  function close(): void {
    // Drop the key first, so it is gone even if the parent keeps this dialog mounted.
    setStep({ kind: 'form' });
    onOpenChange(false);
  }

  const environments = useQuery({
    queryKey: queryKeys.projectEnvironments(draft.projectId),
    queryFn: async () => (await window.runova.environments.list(draft.projectId)) ?? [],
    enabled: open && draft.projectId !== '',
    meta: QUIET,
  });
  const sshServers = useQuery({
    queryKey: queryKeys.sshServers,
    queryFn: async () => (await window.runova.ssh.listServers()) ?? [],
    enabled: open,
    meta: QUIET,
  });
  const sites = useQuery({
    queryKey: queryKeys.deployWordPressSites,
    queryFn: async () => (await window.runova.deployWordPress.listSites()) ?? [],
    enabled: open,
    retry: false,
    meta: QUIET,
  });

  const errors: HealthDraftErrors = submitted ? validateHealthDraft(draft) : {};
  const insecure = isInsecureRemote(draft.url);

  function set<K extends keyof HealthDraft>(key: K, value: HealthDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    const found = validateHealthDraft(draft);
    const first = Object.keys(found)[0];
    if (first) {
      const field =
        first === 'interval'
          ? 'custom-interval'
          : first === 'basicUser'
            ? 'basic-user'
            : first === 'projectId'
              ? 'project'
              : first;
      document.getElementById(id(field))?.focus();
      return;
    }
    const input = healthDraftToInput(draft);
    setBusy(true);
    setProblem(null);
    try {
      if (target) {
        // The sign-in type is fixed once a key exists, so an edit never sends it.
        const { authMode: _mode, basicUser: _user, ...patch } = input;
        await actions.update.mutateAsync({ targetId: target.id, patch });
        close();
      } else {
        const result = await actions.create(input);
        setStep({ kind: 'secret', reveal: result.secret, targetId: result.target.id });
      }
    } catch (error) {
      if (!target) setProblem(ipcErrorMessage(error, 'The target could not be added.'));
    } finally {
      setBusy(false);
    }
  }

  const projectEnvironments = environments.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="flex max-h-[88vh] w-[min(40rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        {step.kind === 'secret' ? (
          <HealthSecretStep
            reveal={step.reveal}
            onDone={close}
            secondary={
              onConnect ? (
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    const targetId = step.targetId;
                    close();
                    onConnect(targetId);
                  }}
                >
                  <Sparkles />
                  Build the endpoint with AI
                </Button>
              ) : null
            }
          />
        ) : (
          <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="px-5 py-4 pr-12 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
              <DialogTitle className="flex items-center gap-2 text-base">
                {editing ? (
                  <Pencil className="h-4 w-4 text-primary" />
                ) : (
                  <HeartPulse className="h-4 w-4 text-primary" />
                )}
                {editing ? `Edit ${target.name}` : 'Add a health check'}
              </DialogTitle>
              <DialogDescription className="text-xs">
                Runova calls the endpoint on its own schedule and tells you when it stops answering
                well.
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
              <FormSection title="What to watch">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id={id('project')} label="Project" error={errors.projectId}>
                    <Combobox
                      id={id('project')}
                      value={draft.projectId}
                      disabled={lockProject}
                      placeholder="Pick a project"
                      searchPlaceholder="Search projects…"
                      emptyText="No project matches."
                      onChange={(value) =>
                        setDraft((current) => ({
                          ...current,
                          projectId: value,
                          environmentId: current.projectId === value ? current.environmentId : '',
                        }))
                      }
                      options={projects.map((one) => ({ value: one.id, label: one.name }))}
                      invalid={Boolean(errors.projectId)}
                      ariaDescribedBy={errors.projectId ? `${id('project')}-error` : undefined}
                    />
                  </Field>
                  <Field
                    id={id('environment')}
                    label="Environment"
                    optional
                    hint={
                      draft.projectId && environments.isSuccess && projectEnvironments.length === 0
                        ? "Add one on the project's Environments tab."
                        : undefined
                    }
                  >
                    <Combobox
                      id={id('environment')}
                      value={draft.environmentId}
                      disabled={!draft.projectId}
                      searchPlaceholder="Search environments…"
                      emptyText="No environment matches."
                      onChange={(value) => set('environmentId', value)}
                      options={[
                        { value: '', label: 'No environment' },
                        ...projectEnvironments.map((env) => ({ value: env.id, label: env.name })),
                      ]}
                    />
                  </Field>
                  <Field id={id('name')} label="Name" error={errors.name}>
                    <Input
                      id={id('name')}
                      value={draft.name}
                      placeholder="API"
                      autoComplete="off"
                      onChange={(event) => set('name', event.target.value)}
                      {...described(id('name'), errors.name, false)}
                    />
                  </Field>
                  <Field id={id('server')} label="Server" optional>
                    <Input
                      id={id('server')}
                      value={draft.serverLabel}
                      placeholder="web-1"
                      autoComplete="off"
                      onChange={(event) => set('serverLabel', event.target.value)}
                    />
                  </Field>
                </div>
                <Field
                  id={id('link')}
                  label="Linked server"
                  optional
                  hint="Links the card to a saved SSH server or WordPress site."
                >
                  <Combobox
                    id={id('link')}
                    value={draft.serverLink}
                    onChange={(value) => set('serverLink', value)}
                    ariaDescribedBy={`${id('link')}-hint`}
                    searchPlaceholder="Search servers and sites…"
                    emptyText="No server or site matches."
                    options={[
                      { value: '', label: 'None' },
                      ...(sshServers.data ?? []).map((server) => ({
                        value: `ssh:${server.id}`,
                        label: `${server.nickname} (${server.host})`,
                        keywords: ['ssh', 'server'],
                        icon: <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
                      })),
                      ...(sites.data ?? []).map((site) => ({
                        value: `wordpress:${site.id}`,
                        label: site.label,
                        keywords: ['wordpress', 'site'],
                        icon: <WordPressMark className="h-3.5 w-3.5 shrink-0" />,
                      })),
                    ]}
                  />
                </Field>
              </FormSection>

              <FormSection title="Endpoint">
                <Field
                  id={id('url')}
                  label="Endpoint URL"
                  error={errors.url}
                  hint={`The full address, usually ending in ${HEALTH_DEFAULT_PATH}.`}
                >
                  <Input
                    id={id('url')}
                    type="url"
                    inputMode="url"
                    value={draft.url}
                    placeholder={`https://your-app${HEALTH_DEFAULT_PATH}`}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono text-[13px]"
                    onChange={(event) => set('url', event.target.value)}
                    {...described(id('url'), errors.url, true)}
                  />
                </Field>

                <div className="space-y-1.5">
                  <p className="text-sm font-medium leading-none">Check every</p>
                  <div
                    role="group"
                    aria-label="Check every"
                    className={cn(SEGMENT_TRACK, 'flex-wrap gap-0.5 rounded-2xl')}
                  >
                    {HEALTH_INTERVAL_PRESETS.map((seconds) => (
                      <button
                        key={seconds}
                        type="button"
                        aria-pressed={draft.intervalChoice === `${seconds}`}
                        onClick={() => set('intervalChoice', `${seconds}` as IntervalChoice)}
                        className={segmentClass(draft.intervalChoice === `${seconds}`)}
                      >
                        {formatHealthInterval(seconds)}
                      </button>
                    ))}
                    <button
                      type="button"
                      aria-pressed={draft.intervalChoice === 'custom'}
                      onClick={() => set('intervalChoice', 'custom')}
                      className={segmentClass(draft.intervalChoice === 'custom')}
                    >
                      Custom
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {draft.intervalChoice === 'custom' && (
                    <Field
                      id={id('custom-interval')}
                      label="Seconds between checks"
                      error={errors.interval}
                    >
                      <Input
                        id={id('custom-interval')}
                        inputMode="numeric"
                        value={draft.customInterval}
                        placeholder="120"
                        onChange={(event) => set('customInterval', event.target.value)}
                        {...described(id('custom-interval'), errors.interval, false)}
                      />
                    </Field>
                  )}
                  <Field
                    id={id('timeout')}
                    label="Timeout in seconds"
                    error={errors.timeout}
                    hint="How long to wait for an answer before calling it unreachable."
                  >
                    <Input
                      id={id('timeout')}
                      inputMode="numeric"
                      value={draft.timeout}
                      onChange={(event) => set('timeout', event.target.value)}
                      {...described(id('timeout'), errors.timeout, true)}
                    />
                  </Field>
                </div>
              </FormSection>

              <FormSection title="Sign-in">
                {editing ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Signs in with{' '}
                    <span className="font-medium text-foreground">
                      {draft.authMode === 'basic'
                        ? `HTTP Basic as ${draft.basicUser}`
                        : 'a Bearer key'}
                    </span>
                    . To use a different kind, remove this target and add it again. To replace the
                    key itself, use Rotate key in the target's menu.
                  </p>
                ) : (
                  <>
                    <div
                      role="radiogroup"
                      aria-label="Sign-in"
                      className="grid gap-2 sm:grid-cols-2"
                    >
                      {AUTH_OPTIONS.map((option) => {
                        const checked = draft.authMode === option.mode;
                        return (
                          <button
                            key={option.mode}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            onClick={() => set('authMode', option.mode)}
                            className={cn(
                              'flex cursor-pointer flex-col gap-1 rounded-xl px-3 py-2.5 text-left ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              checked
                                ? 'bg-primary/10 ring-primary/35'
                                : 'bg-foreground/[0.03] ring-foreground/[0.08] hover:bg-foreground/[0.06]',
                            )}
                          >
                            <span className="flex items-center gap-2 text-sm font-medium">
                              <span
                                aria-hidden
                                className={cn(
                                  'flex h-3.5 w-3.5 items-center justify-center rounded-full ring-1 ring-inset',
                                  checked ? 'ring-primary' : 'ring-foreground/30',
                                )}
                              >
                                {checked && (
                                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                                )}
                              </span>
                              {option.title}
                              {option.badge && (
                                <span className="rounded-full bg-primary/12 px-1.5 text-[10px] font-semibold text-primary">
                                  {option.badge}
                                </span>
                              )}
                            </span>
                            <span className="text-xs leading-relaxed text-muted-foreground">
                              {option.body}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {draft.authMode === 'basic' && (
                      <Field
                        id={id('basic-user')}
                        label="Username"
                        error={errors.basicUser}
                        className="sm:max-w-[50%]"
                      >
                        <Input
                          id={id('basic-user')}
                          value={draft.basicUser}
                          placeholder="runova"
                          autoComplete="off"
                          onChange={(event) => set('basicUser', event.target.value)}
                          {...described(id('basic-user'), errors.basicUser, false)}
                        />
                      </Field>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Runova makes the {draft.authMode === 'basic' ? 'password' : 'key'} for you and
                      shows it once, right after you add the target.
                    </p>
                  </>
                )}
              </FormSection>

              <FormSection title="Options">
                <SwitchRow
                  id={id('diagnose')}
                  label="Diagnose with AI"
                  description="When an incident opens, an agent reads the errors and suggests a cause. It only reads; it changes nothing."
                  checked={draft.autoDiagnose}
                  onCheckedChange={(checked) => set('autoDiagnose', checked)}
                />
                <SwitchRow
                  id={id('insecure')}
                  label="Allow insecure HTTP"
                  description="Lets Runova call a plain http:// address on another machine."
                  checked={draft.allowInsecure}
                  onCheckedChange={(checked) => set('allowInsecure', checked)}
                />
                {draft.allowInsecure && (
                  <Notice tone="warning" size="sm">
                    Plain HTTP sends the {draft.authMode === 'basic' ? 'password' : 'key'} and the
                    report unencrypted. Anyone on the network between here and the server can read
                    them and call your endpoint. Use it only on a network you trust
                    {insecure ? '' : ', and turn it off again once the site has HTTPS'}.
                  </Notice>
                )}
              </FormSection>

              {problem && <Problem message={problem} />}
            </div>

            <DialogFooter className={cn(FOOTER_HAIRLINE, 'px-5 py-3')}>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy} aria-busy={busy}>
                {busy && <Spinner className="h-3.5 w-3.5 animate-spin" />}
                {editing ? 'Save changes' : 'Add target'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
