import type {
  RecaptchaKey,
  RecaptchaKeyType,
  RecaptchaProjectRef,
} from '@shared/deployRecaptchaTypes';
import { parseDomainList } from '@shared/recaptcha/domains';
import { recaptchaErrorCode } from '@shared/recaptchaErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Code, Pencil, Plus, Spinner, Trash2 } from '@/components/icons';
import {
  Chip,
  EmptyState,
  FOOTER_HAIRLINE,
  Notice,
  PillTabs,
  Problem,
  SearchPill,
  SectionCard,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { recaptchaFailureText, useRecaptchaError } from '@/lib/recaptcha/feedback';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { KeyDialog, type KeyDialogMode } from './KeyDialog';
import { CopyButton, SecretReveal, TYPE_NAMES, TypeChip } from './keyParts';
import { RecaptchaMark } from './RecaptchaMark';

/** With more keys than this, the card offers a search and a type filter. */
const SEARCH_FROM = 7;
const DOMAINS_SHOWN = 4;

type TypeFilter = 'all' | RecaptchaKeyType;

function madeOn(createdAt: string | null): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime())
    ? null
    : `Made ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function KeysSkeleton(): React.JSX.Element {
  return (
    <div className={cn(FOOTER_HAIRLINE, 'settings-rows')} aria-busy="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="space-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-3.5 w-3/5" />
        </div>
      ))}
    </div>
  );
}

function KeyRow({
  keyItem,
  project,
  onOpen,
  onDelete,
}: {
  keyItem: RecaptchaKey;
  project: RecaptchaProjectRef;
  onOpen: (mode: KeyDialogMode) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const hidden = keyItem.domains.slice(DOMAINS_SHOWN);
  const made = madeOn(keyItem.createdAt);
  return (
    <li aria-label={keyItem.name} className="flex flex-wrap items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{keyItem.name}</span>
          <TypeChip type={keyItem.type} />
          {made && <span className="text-[11px] text-muted-foreground">{made}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {keyItem.allowAllDomains ? (
            <Chip tone="warning">Any domain</Chip>
          ) : (
            keyItem.domains.slice(0, DOMAINS_SHOWN).map((domain) => (
              <Chip key={domain} className="font-mono">
                {domain}
              </Chip>
            ))
          )}
          {hidden.length > 0 && (
            <SimpleTooltip label={hidden.join(', ')}>
              <span>
                <Chip>+{hidden.length}</Chip>
              </span>
            </SimpleTooltip>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex min-w-0 items-center gap-1">
            <span className="text-muted-foreground">Site key</span>
            <code className="truncate font-mono text-foreground/90">{keyItem.id}</code>
            <CopyButton text={keyItem.id} label="Copy site key" />
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground">Secret</span>
            <SecretReveal keyRef={{ ...project, keyId: keyItem.id }} />
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="soft"
          size="sm"
          onClick={() => onOpen({ kind: 'ready', key: keyItem })}
        >
          <Code className="h-3.5 w-3.5" /> Add to your site
        </Button>
        <SimpleTooltip label="Edit">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${keyItem.name}`}
            onClick={() => onOpen({ kind: 'edit', key: keyItem })}
          >
            <Pencil />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Delete">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${keyItem.name}`}
            className="hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </SimpleTooltip>
      </div>
    </li>
  );
}

/** The fix that goes with a failure to read the keys, when there is one. */
function LoadProblem({
  error,
  project,
  onRetry,
}: {
  error: unknown;
  project: RecaptchaProjectRef;
  onRetry: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const message = useRecaptchaError(error) ?? '';
  const [turningOn, setTurningOn] = useState(false);
  const code = recaptchaErrorCode(error);

  if (code === 'api-disabled') {
    return (
      <Notice
        tone="warning"
        className="items-center"
        action={
          <Button
            size="sm"
            disabled={turningOn}
            onClick={async () => {
              setTurningOn(true);
              try {
                await window.runova.deployRecaptcha.prepareProject(project);
                onRetry();
              } catch (failure) {
                toast.error(recaptchaFailureText(failure, queryClient));
              } finally {
                setTurningOn(false);
              }
            }}
          >
            {turningOn && <Spinner className="h-3.5 w-3.5" />} Turn reCAPTCHA on
          </Button>
        }
      >
        {message} Turn it on to see and make keys here.
      </Notice>
    );
  }
  const hint =
    code === 'permission'
      ? ' Ask an owner of the project for the reCAPTCHA Enterprise Admin role, or pick another project.'
      : '';
  return <Problem message={`${message}${hint}`} onRetry={onRetry} />;
}

/**
 * The project's keys (E40): each with its type, domains, site key to copy and secret on request,
 * plus the code to paste and edit and delete. A `?newKey=` link (from a site's page) opens the
 * create dialog filled in with that site.
 */
export function KeysCard({ project }: { project: RecaptchaProjectRef }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const keysKey = queryKeys.recaptchaKeys(project.accountId, project.projectId);
  const keys = useQuery({
    queryKey: keysKey,
    queryFn: () => window.runova.deployRecaptcha.listKeys(project),
  });
  const [dialog, setDialog] = useState<KeyDialogMode | null>(() => {
    const linked = params.get('newKey');
    if (linked === null) return null;
    const domains = parseDomainList(linked.replace(/,/g, ' ')).domains;
    return { kind: 'create', initial: { name: params.get('label') ?? '', domains } };
  });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TypeFilter>('all');

  // The link has done its job once the dialog is open; leave the rest of the address alone.
  useEffect(() => {
    if (!params.has('newKey') && !params.has('label')) return;
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('newKey');
        next.delete('label');
        return next;
      },
      { replace: true },
    );
  }, [params, setParams]);

  async function remove(key: RecaptchaKey): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete the key for ${key.name}?`,
      description: `Sites that use it stop passing checks right away, so their forms stop working until they get a new key. This cannot be undone.`,
      confirmLabel: 'Delete key',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.deployRecaptcha.deleteKey({ ...project, keyId: key.id });
      toast.success(`Deleted ${key.name}.`);
      await queryClient.invalidateQueries({ queryKey: keysKey });
    } catch (error) {
      toast.error(recaptchaFailureText(error, queryClient));
    }
  }

  const all = keys.data ?? [];
  const searching = all.length >= SEARCH_FROM;
  const needle = search.trim().toLowerCase();
  const shown = all.filter(
    (key) =>
      (filter === 'all' || key.type === filter) &&
      (!needle ||
        key.name.toLowerCase().includes(needle) ||
        key.id.toLowerCase().includes(needle) ||
        key.domains.some((domain) => domain.includes(needle))),
  );

  let body: React.ReactNode;
  if (keys.isPending) {
    body = <KeysSkeleton />;
  } else if (keys.isError) {
    body = (
      <div className="p-4">
        <LoadProblem error={keys.error} project={project} onRetry={() => void keys.refetch()} />
      </div>
    );
  } else if (all.length === 0) {
    body = (
      <EmptyState
        size="md"
        icon={RecaptchaMark}
        title="No keys yet"
        description="Make a key for one of your sites. It takes a few seconds, and you get the code to paste right after."
        className={FOOTER_HAIRLINE}
        action={
          <Button onClick={() => setDialog({ kind: 'create' })}>
            <Plus className="h-3.5 w-3.5" /> Create your first key
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        {searching && (
          <div className={cn(FOOTER_HAIRLINE, 'flex flex-wrap items-center gap-2 px-4 py-2')}>
            <SearchPill
              type="search"
              label="Search keys"
              clearLabel="Clear filter"
              placeholder="Search by name, domain or key"
              value={search}
              onValueChange={setSearch}
              className="min-w-[12rem] flex-1"
            />
            <PillTabs
              id="recaptcha-type-filter"
              label="Key type"
              kind="toggle"
              size="xs"
              items={[
                { value: 'all', label: 'All' },
                ...(['score', 'checkbox', 'invisible'] as const).map((type) => ({
                  value: type,
                  label: TYPE_NAMES[type],
                })),
              ]}
              value={filter}
              onChange={setFilter}
            />
          </div>
        )}
        {shown.length === 0 ? (
          <p className={cn(FOOTER_HAIRLINE, 'px-4 py-6 text-center text-sm text-muted-foreground')}>
            No key matches that.
          </p>
        ) : (
          <ul aria-label="Keys" className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
            {shown.map((key) => (
              <KeyRow
                key={key.id}
                keyItem={key}
                project={project}
                onOpen={setDialog}
                onDelete={() => void remove(key)}
              />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <SectionCard
      flush
      icon={<RecaptchaMark className="h-4 w-4" />}
      title="Keys"
      description={
        keys.data ? `${all.length} key${all.length === 1 ? '' : 's'} in this project` : undefined
      }
      actions={
        all.length > 0 && (
          <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
            <Plus className="h-3.5 w-3.5" /> New key
          </Button>
        )
      }
      className="flex min-w-0 flex-col"
    >
      {body}
      {dialog && (
        <KeyDialog
          open
          mode={dialog}
          project={project}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
      )}
    </SectionCard>
  );
}
