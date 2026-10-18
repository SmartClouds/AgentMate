import type { Project } from '@agentmat/core';
import type { ErrorConnectionSummary, ErrorTokenCheck } from '@shared/errorTrackingTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  CircleQuestion,
  CircleX,
  Copy,
  ExternalLink,
  Key,
  Lock,
  Plus,
  Spinner,
  Trash2,
} from '@/components/icons';
import { Chip, Notice, Problem, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { copyText } from '../health/promptParts';
import { ErrorLinkProjects } from './ErrorLinkProjects';
import { SCOPE_LIST_TEXT, type ScopeRow, scopeChecklist, tokenPageUrl } from './errorView';
import { useErrorConnections, useErrorLinks } from './useErrorTracking';

/**
 * Where Sentry is connected and linked (E24): the saved connections with their state, the add
 * flow (host, token, a check that shows what the token can do, then the organization), and the
 * project links. A token is held in this dialog's state only until it is saved, then dropped.
 */

type HostChoice = 'us' | 'eu' | 'self';

const HOSTS: Record<Exclude<HostChoice, 'self'>, string> = {
  us: 'https://sentry.io',
  eu: 'https://de.sentry.io',
};

const HOST_OPTIONS = [
  { value: 'us', label: 'Sentry.io (US)' },
  { value: 'eu', label: 'Sentry.io (EU)' },
  { value: 'self', label: 'Self-hosted or GlitchTip' },
];

function invalidateAll(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.errorTracking });
}

const SCOPE_STATE = {
  granted: { Icon: CircleCheck, tone: 'text-success', word: 'Granted' },
  missing: { Icon: CircleX, tone: 'text-destructive', word: 'Missing' },
  unknown: { Icon: CircleQuestion, tone: 'text-muted-foreground', word: 'Not reported' },
} as const;

function ScopeList({ rows }: { rows: ScopeRow[] }): React.JSX.Element {
  return (
    <ul aria-label="Token scopes" className="space-y-1.5">
      {rows.map((row) => {
        const state = SCOPE_STATE[row.state];
        // A missing optional scope is not a failure, so it reads as a note rather than in red.
        const soft = row.optional && row.state === 'missing';
        return (
          <li key={row.scope} className="flex items-center gap-2 text-xs">
            <state.Icon
              className={cn('h-3.5 w-3.5 shrink-0', soft ? 'text-muted-foreground' : state.tone)}
            />
            <span className="font-mono font-medium">{row.scope}</span>
            <span className={cn(soft ? 'text-muted-foreground' : state.tone)}>{state.word}</span>
            {row.optional && (
              <span className="text-muted-foreground">
                (optional, needed for Resolve and Ignore)
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The three read scopes, said as a list a person would write. */
function scopeWords(scopes: readonly string[]): string {
  if (scopes.length <= 1) return scopes.join('');
  return `${scopes.slice(0, -1).join(', ')} and ${scopes.at(-1)}`;
}

function AddConnectionForm({
  onCancel,
  onSaved,
}: {
  onCancel?: () => void;
  onSaved: (saved: ErrorConnectionSummary) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const urlId = useId();
  const tokenId = useId();
  const [choice, setChoice] = useState<HostChoice>('us');
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [check, setCheck] = useState<ErrorTokenCheck | null>(null);
  const [orgSlug, setOrgSlug] = useState('');
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const host = choice === 'self' ? serverUrl.trim() : HOSTS[choice];
  const ready = token.trim() !== '' && host !== '';
  const blocked = check !== null && check.missingScopes.length > 0;

  function reset(): void {
    setCheck(null);
    setOrgSlug('');
    setProblem(null);
  }

  async function runCheck(): Promise<void> {
    if (!ready) return;
    setBusy('check');
    reset();
    try {
      const result = await window.agentmat.errorTracking.checkToken({
        provider: 'sentry',
        host,
        token: token.trim(),
      });
      setCheck(result);
      setOrgSlug(result.organizations[0]?.slug ?? '');
    } catch (error) {
      setProblem(ipcErrorMessage(error, 'Could not check the token.'));
    } finally {
      setBusy(null);
    }
  }

  async function save(): Promise<void> {
    if (!check || !orgSlug || blocked) return;
    setBusy('save');
    setProblem(null);
    try {
      const saved = await window.agentmat.errorTracking.addConnection({
        provider: 'sentry',
        host: check.host || host,
        token: token.trim(),
        orgSlug,
      });
      setToken('');
      toast.success(`Connected to ${saved?.orgName ?? 'Sentry'}`, {
        description: 'Now link your projects to see their errors.',
      });
      invalidateAll(queryClient);
      onSaved(saved);
    } catch (error) {
      setProblem(ipcErrorMessage(error, 'Could not save the connection.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Add a connection" className={cn(SECTION_WELL, 'space-y-4 p-4')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className={SECTION_HEADING}>Where your Sentry is</p>
          <Combobox
            ariaLabel="Sentry host"
            value={choice}
            onChange={(value) => {
              setChoice((value || 'us') as HostChoice);
              reset();
            }}
            options={HOST_OPTIONS}
            searchPlaceholder="Search hosts…"
          />
        </div>
        {choice === 'self' && (
          <div className="space-y-1.5">
            <Label htmlFor={urlId}>Server URL</Label>
            <Input
              id={urlId}
              value={serverUrl}
              onChange={(event) => {
                setServerUrl(event.target.value);
                reset();
              }}
              placeholder="https://sentry.example.com"
              spellCheck={false}
            />
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor={tokenId}>Auth token</Label>
          <a
            href={tokenPageUrl(host)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            Create a token
          </a>
        </div>
        <SecretInput
          id={tokenId}
          value={token}
          onChange={(value) => {
            setToken(value);
            reset();
          }}
          placeholder="sntryu_…"
        />
        <p className="text-[11px] text-muted-foreground">
          A personal token with {SCOPE_LIST_TEXT}. The last one is optional and lets you resolve and
          ignore issues from here.
        </p>
      </div>

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}

      {check && (
        <div className="space-y-3">
          <ScopeList rows={scopeChecklist(check)} />
          {check.warning && (
            <Notice tone="warning" size="sm">
              {check.warning}
            </Notice>
          )}
          {blocked ? (
            <Notice tone="destructive" size="sm">
              This token cannot read issues. AgentMate needs {scopeWords(check.missingScopes)}. Make
              a new token with them.
            </Notice>
          ) : check.organizations.length === 0 ? (
            <Notice tone="warning" size="sm">
              The token works but sees no organization.
            </Notice>
          ) : (
            <div className="space-y-1.5">
              <p className={SECTION_HEADING}>Organization</p>
              <Combobox
                ariaLabel="Organization"
                value={orgSlug}
                onChange={setOrgSlug}
                options={check.organizations.map((one) => ({
                  value: one.slug,
                  label: one.name,
                  keywords: [one.slug],
                }))}
                searchPlaceholder="Search organizations…"
              />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          variant={check ? 'soft' : 'default'}
          disabled={!ready || busy !== null}
          onClick={() => void runCheck()}
        >
          {busy === 'check' && <Spinner className="animate-spin" />}
          Check token
        </Button>
        {check && (
          <Button
            size="sm"
            disabled={blocked || !orgSlug || busy !== null}
            onClick={() => void save()}
          >
            {busy === 'save' && <Spinner className="animate-spin" />}
            Save connection
          </Button>
        )}
      </div>
    </section>
  );
}

function ConnectionRow({ conn }: { conn: ErrorConnectionSummary }): React.JSX.Element {
  const queryClient = useQueryClient();
  const tokenId = useId();
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function replace(): Promise<void> {
    if (!token.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      await window.agentmat.errorTracking.replaceToken(conn.id, token.trim());
      setToken('');
      setReplacing(false);
      toast.success('Token replaced');
      invalidateAll(queryClient);
    } catch (error) {
      setProblem(ipcErrorMessage(error, 'Could not replace the token.'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove ${conn.label}?`,
      description:
        'AgentMate forgets the token and the project links for this organization. Nothing changes in Sentry.',
      icon: Trash2,
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.agentmat.errorTracking.removeConnection(conn.id);
      toast.success('Connection removed');
      invalidateAll(queryClient);
    } catch (error) {
      toast.error('Could not remove the connection', {
        description: ipcErrorMessage(error, 'Something went wrong.'),
      });
    }
  }

  return (
    <li className="space-y-2.5 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{conn.label}</span>
            {conn.locked ? (
              <Chip tone="warning" dot>
                <Lock />
                Locked
              </Chip>
            ) : conn.problem ? (
              <Chip tone="destructive" dot>
                {conn.problem}
              </Chip>
            ) : (
              <Chip tone="success" dot>
                Connected
              </Chip>
            )}
            {!conn.canWrite && (
              <SimpleTooltip label="The token has no event:write scope, so issues can be read but not resolved or ignored.">
                <Chip tabIndex={0}>Read only</Chip>
              </SimpleTooltip>
            )}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {conn.orgSlug} · {conn.host.replace(/^https?:\/\//, '')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="soft" onClick={() => setReplacing((value) => !value)}>
            <Key />
            Replace token
          </Button>
          <Button size="xs" variant="danger" onClick={() => void remove()}>
            <Trash2 />
            Remove
          </Button>
        </div>
      </div>
      {replacing && (
        <div className="space-y-1.5">
          <Label htmlFor={tokenId}>New auth token</Label>
          <div className="flex items-center gap-1.5">
            <div className="flex-1">
              <SecretInput id={tokenId} value={token} onChange={setToken} placeholder="sntryu_…" />
            </div>
            <Button size="sm" disabled={busy || !token.trim()} onClick={() => void replace()}>
              {busy && <Spinner className="animate-spin" />}
              Save token
            </Button>
          </div>
          {problem && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function ErrorConnectionsDialog({
  open,
  onOpenChange,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly Project[];
}): React.JSX.Element {
  const connections = useErrorConnections();
  const list = connections.data ?? [];
  const links = useErrorLinks(undefined, open && list.length > 0);
  const [adding, setAdding] = useState(false);
  const showForm = adding || (connections.isSuccess && list.length === 0);
  const linkable = list.some((one) => !one.locked);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setAdding(false);
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[88vh] w-[min(46rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        <DialogHeader className="px-5 py-4 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
          <DialogTitle className="text-base">Error tracking connections</DialogTitle>
          <DialogDescription className="text-xs">
            The Sentry organizations AgentMate reads errors from. Tokens are encrypted on this
            computer and never shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {connections.isLoading && (
            <div role="status" aria-label="Loading connections" className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          )}
          {connections.isError && (
            <Problem
              message={`Could not load the connections: ${ipcErrorMessage(connections.error, 'Something went wrong.')}`}
              onRetry={() => void connections.refetch()}
            />
          )}
          {list.length > 0 && (
            <div className="space-y-1">
              <p className={SECTION_HEADING}>Connected</p>
              <ul aria-label="Connections" className="divide-y divide-foreground/[0.06]">
                {list.map((conn) => (
                  <ConnectionRow key={conn.id} conn={conn} />
                ))}
              </ul>
            </div>
          )}

          {showForm ? (
            <AddConnectionForm
              onCancel={list.length > 0 ? () => setAdding(false) : undefined}
              onSaved={() => setAdding(false)}
            />
          ) : (
            connections.isSuccess && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="soft" onClick={() => setAdding(true)}>
                  <Plus />
                  Add a connection
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => copyText(SCOPE_LIST_TEXT, 'Scopes')}
                >
                  <Copy />
                  Copy scopes
                </Button>
              </div>
            )
          )}

          {linkable && (
            <ErrorLinkProjects
              projects={projects}
              connections={list}
              links={links.data ?? []}
              className="pt-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
