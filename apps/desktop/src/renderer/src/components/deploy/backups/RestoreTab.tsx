import { coreErrorMessage } from '@shared/coreErrors';
import { backupSize } from '@shared/deploy/backupSchedule';
import type {
  PendingServerRestore,
  ServerRestoreStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployBackupFile } from '@shared/deployHardeningTypes';
import type {
  DeployMovedRecordArea,
  DeployServerRestoreSource,
} from '@shared/deployServerBackupsTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArchiveRestore,
  CircleCheck,
  CircleX,
  FolderOpen,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Chip, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Skeleton } from '@/components/ui/skeleton';
import { offerFirewallRules } from '@/lib/deploy/firewall/restoredRules';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import {
  type RestorePhase,
  type ServerRestore,
  useDeployBackupRunStore,
} from '@/stores/deployBackupRunStore';
import { CARD_BODY, SecurityCard, TABLE_CELL, TABLE_HEAD } from '../security/SecurityCard';
import { useStepUp } from '../security/useStepUp';
import { dateAndTime, TARGET_STATE } from './format';
import {
  useBackupDestinations,
  useDeployServers,
  usePendingRestore,
  useRefreshBackups,
  useStoredBackups,
} from './hooks';

/**
 * The restore wizard (E28). First the backup and where it goes: a backup on a destination (this
 * server's, or another Deploy server's), or a file on this computer, onto this server or another
 * one that has the core. Then the core's own state comes back the E15 way over SSH, checked with
 * the secret key before anything changes, and this computer signs in as the backup's Owner. Last,
 * what the backup brings is shown and the server is brought up: volumes, images, containers and
 * the apps, and on a new address the settings that named the old one. DNS the core cannot change
 * is listed to change by hand, and the backup's firewall rules are offered to the Firewall
 * section's usual review.
 */

export interface RestoreChoice {
  serverId: string;
  destinationId: string;
  backupId: string;
}

const NO_STEPS: ServerRestore['steps'] = [];

const AREA: Record<DeployMovedRecordArea, string> = {
  server: 'Saved server',
  healthCheck: 'Health check',
  fileSite: 'FTP or SFTP site',
  wordpressSite: 'WordPress site',
};

/** On a new server the old addresses are not among its own. */
function addressesMoved(pending: PendingServerRestore): boolean {
  const fresh = new Set(pending.newAddresses.map((one) => one.toLowerCase()));
  return (
    pending.oldAddresses.length > 0 &&
    !pending.oldAddresses.some((old) => fresh.has(old.toLowerCase()))
  );
}

export function RestoreTab({
  server,
  userName,
  initial,
}: {
  server: DeployServer;
  userName?: string;
  initial: RestoreChoice | null;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [, setParams] = useSearchParams();
  const servers = useDeployServers();
  const [sourceKind, setSourceKind] = useState<'destination' | 'file'>('destination');
  const [sourceServerId, setSourceServerId] = useState(initial?.serverId ?? server.id);
  const [destinationId, setDestinationId] = useState<string | null>(initial?.destinationId ?? null);
  const [backupId, setBackupId] = useState<string | null>(initial?.backupId ?? null);
  const [file, setFile] = useState<DeployBackupFile | null>(null);
  // A restore runs in the backup store, so leaving the page mid-way keeps it and its steps.
  const [targetId, setTargetId] = useState(
    () => useDeployBackupRunStore.getState().restores[server.id]?.targetId ?? server.id,
  );
  const [secret, setSecret] = useState('');
  const [owner, setOwner] = useState(userName ?? '');
  const [password, setPassword] = useState('');
  const [sudo, setSudo] = useState('');
  const kept = useDeployBackupRunStore((state): ServerRestore | undefined => {
    const restore = state.restores[server.id];
    return restore?.targetId === targetId ? restore : undefined;
  });
  const phase: RestorePhase = kept?.phase ?? 'form';
  const steps = kept?.steps ?? NO_STEPS;
  const bringUpStatus = kept?.bringUpStatus ?? null;
  const result = kept?.result ?? null;
  const problem = kept?.problem ?? null;
  const setPhase = (next: RestorePhase) =>
    useDeployBackupRunStore.getState().setRestorePhase(server.id, targetId, next);
  const setProblem = (next: string | null) =>
    useDeployBackupRunStore.getState().setRestoreProblem(server.id, targetId, next);
  const [move, setMove] = useState<boolean | null>(null);

  useEffect(() => {
    if (!initial) return;
    setSourceKind('destination');
    setSourceServerId(initial.serverId);
    setDestinationId(initial.destinationId);
    setBackupId(initial.backupId);
  }, [initial]);

  const destinations = useBackupDestinations(sourceServerId, sourceKind === 'destination');
  const shownDestination = destinationId ?? destinations.data?.[0]?.id ?? null;
  const stored = useStoredBackups(
    sourceServerId,
    sourceKind === 'destination' ? shownDestination : null,
  );
  const pending = usePendingRestore(targetId);
  const refresh = useRefreshBackups(targetId);

  // A restored state is read again once the restore is through, even one that finished while the
  // page was left.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new phase reads it again
  useEffect(() => {
    if (phase === 'pending' || phase === 'done') void pending.refetch();
  }, [phase]);

  const deployServers = servers.data ?? [server];
  const target = deployServers.find((one) => one.id === targetId) ?? server;
  const sourceServer = deployServers.find((one) => one.id === sourceServerId) ?? server;
  // Fetching from a destination needs a step-up on the server that holds it, and bringing the
  // restored server up one on the server restored onto, which may be another server.
  const sourceStepUp = useStepUp(sourceServer);
  const targetStepUp = useStepUp(target);
  const serverOptions = deployServers
    .filter((one) => one.core && one.enrolled)
    .map((one) => ({ value: one.id, label: one.nickname }));
  const targetOptions = deployServers
    .filter((one) => !one.dev)
    .map((one) => ({ value: one.id, label: one.nickname }));

  const source: DeployServerRestoreSource | null =
    sourceKind === 'file'
      ? file
        ? { kind: 'file', fileToken: file.token }
        : null
      : shownDestination && backupId
        ? {
            kind: 'destination',
            serverId: sourceServerId,
            destinationId: shownDestination,
            backupId,
          }
        : null;
  const ready =
    phase === 'form' &&
    source !== null &&
    !target.dev &&
    target.core !== undefined &&
    target.core !== null &&
    secret.length > 0 &&
    owner.trim().length > 0 &&
    password.length > 0;

  async function pick(): Promise<void> {
    setProblem(null);
    try {
      const picked = await window.runova.deployServerBackups.pickFile();
      if (picked) setFile(picked);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    }
  }

  async function restore(): Promise<void> {
    if (!ready || !source) return;
    const confirmed = await confirmDialog({
      title: `Restore the backup onto ${target.nickname}?`,
      description:
        'The server core on it takes the backup in place of what it knows now: its users, computers, apps, sites, certificates and keys. Every session ends. The state it has now is kept on the server, root only, in case you need it.',
      warning: `Type ${target.nickname} to restore. After this you see what the backup brings, and bring the apps and their volumes back from there.`,
      confirmLabel: 'Restore',
      variant: 'destructive',
      typeToConfirm: target.nickname,
    });
    if (!confirmed) return;
    const run = () =>
      window.runova.deployServerBackups.restore({
        serverId: target.id,
        source,
        secret,
        sudoPassword: sudo || null,
        userName: owner.trim(),
        password,
      });
    // A file from this computer goes over SSH alone; a fetch from a destination is a core call.
    await useDeployBackupRunStore
      .getState()
      .restore(
        server.id,
        target.id,
        source.kind === 'destination' ? () => sourceStepUp.run(run) : run,
        async () => {
          void queryClient.invalidateQueries({ queryKey: ['deploy'] });
        },
      );
  }

  const waiting = pending.data ?? null;
  const moveAddresses = move ?? (waiting ? addressesMoved(waiting) : false);

  async function bringUp(): Promise<void> {
    if (!waiting) return;
    await useDeployBackupRunStore.getState().bringUp(
      server.id,
      () =>
        targetStepUp.run(() =>
          window.runova.deployServerBackups.bringUp({
            serverId: target.id,
            moveAddresses,
            ...(password ? { password } : {}),
          }),
        ),
      () => {
        refresh();
        void queryClient.invalidateQueries({ queryKey: queryKeys.deployServers });
      },
    );
  }

  function reviewFirewall(): void {
    if (!waiting) return;
    offerFirewallRules(target.id, waiting.firewallRules);
    setParams({ server: target.id, view: 'firewall', fix: 'restore-rules' });
  }

  const id = (name: string) => `restore-wizard-${name}-${server.id}`;
  const showSummary =
    (phase === 'pending' || phase === 'bringingUp' || phase === 'done') && waiting;

  return (
    <SecurityCard
      icon={<ArchiveRestore />}
      title="Restore"
      description="Bring a backup back onto this server, or onto another one. The panel, its settings, the apps and their volumes come back, and what was running starts again."
    >
      <div className={cn(CARD_BODY, 'space-y-4')}>
        {phase === 'form' && waiting && (
          <Notice tone="primary" className="text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                A restored state waits to be brought up on {target.nickname}: the backup of{' '}
                {waiting.hostName} from {dateAndTime(waiting.createdAtUnixMs)}.
              </span>
              <Button size="sm" variant="soft" onClick={() => setPhase('pending')}>
                Continue with it
              </Button>
            </div>
          </Notice>
        )}

        {(phase === 'form' || phase === 'restoring') && (
          <>
            <fieldset className="space-y-2" disabled={phase !== 'form'}>
              <legend className="mb-1 text-sm font-medium">The backup</legend>
              <div
                role="radiogroup"
                aria-label="Where the backup is"
                className="flex flex-wrap gap-4"
              >
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={id('source')}
                    checked={sourceKind === 'destination'}
                    onChange={() => setSourceKind('destination')}
                  />
                  A backup on a destination
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={id('source')}
                    checked={sourceKind === 'file'}
                    onChange={() => setSourceKind('file')}
                  />
                  A file on this computer
                </label>
              </div>

              {sourceKind === 'destination' ? (
                <div className="space-y-2">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={id('from')}>From the server</Label>
                      <Combobox
                        id={id('from')}
                        ariaLabel="From the server"
                        options={serverOptions}
                        value={sourceServerId}
                        onChange={(value) => {
                          if (!value) return;
                          setSourceServerId(value);
                          setDestinationId(null);
                          setBackupId(null);
                        }}
                        searchable={false}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={id('destination')}>Destination</Label>
                      <Combobox
                        id={id('destination')}
                        ariaLabel="Destination"
                        options={(destinations.data ?? []).map((one) => ({
                          value: one.id,
                          label: one.name,
                        }))}
                        value={shownDestination ?? ''}
                        onChange={(value) => {
                          if (!value) return;
                          setDestinationId(value);
                          setBackupId(null);
                        }}
                        placeholder="No destinations"
                        searchable={false}
                      />
                    </div>
                  </div>
                  {destinations.isError && (
                    <p role="alert" className="text-xs text-destructive">
                      {coreErrorMessage(destinations.error)}
                    </p>
                  )}
                  {stored.isPending && shownDestination ? (
                    <div aria-busy="true" className="space-y-1.5">
                      <Skeleton className="h-4 w-72 max-w-full" />
                      <Skeleton className="h-4 w-64 max-w-full" />
                    </div>
                  ) : stored.isError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {coreErrorMessage(stored.error)}
                    </p>
                  ) : (stored.data ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {shownDestination
                        ? 'This destination holds no backups.'
                        : 'Add a destination first.'}
                    </p>
                  ) : (
                    <div role="radiogroup" aria-label="Backups" className="space-y-1">
                      {(stored.data ?? []).map((backup) => (
                        <label key={backup.backupId} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={id('backup')}
                            checked={backupId === backup.backupId}
                            onChange={() => setBackupId(backup.backupId)}
                          />
                          {backup.serverName}, {dateAndTime(backup.createdAtUnixMs)},{' '}
                          {backupSize(backup.sizeBytes)}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" size="sm" variant="soft" onClick={() => void pick()}>
                    <FolderOpen className="h-3.5 w-3.5" />
                    {file ? 'Pick another file' : 'Pick the backup file'}
                  </Button>
                  {file && (
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {file.name} ({backupSize(file.sizeBytes)})
                    </span>
                  )}
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-3" disabled={phase !== 'form'}>
              <legend className="mb-1 text-sm font-medium">Where it goes</legend>
              <div className="max-w-sm space-y-1.5">
                <Label htmlFor={id('target')}>Restore onto</Label>
                <Combobox
                  id={id('target')}
                  ariaLabel="Restore onto"
                  options={targetOptions}
                  value={targetId}
                  onChange={(value) => value && setTargetId(value)}
                  searchable={false}
                />
              </div>
              {target.dev && (
                <p className="text-xs text-muted-foreground">
                  The DevHost has no SSH to restore over. Pick another server.
                </p>
              )}
              {!target.core && (
                <Notice tone="warning" icon={TriangleAlert} className="text-xs">
                  <span>
                    {target.nickname} has no server core yet. Install it first, then come back here.{' '}
                    <Button
                      size="sm"
                      variant="link"
                      className="h-auto p-0 text-xs"
                      onClick={() => setParams({ server: target.id })}
                    >
                      Install the core on {target.nickname}
                    </Button>
                  </span>
                </Notice>
              )}
              {target.id !== sourceServerId && sourceKind === 'destination' && (
                <p className="text-xs text-muted-foreground">
                  The backup is fetched on{' '}
                  {deployServers.find((one) => one.id === sourceServerId)?.nickname ??
                    'the other server'}{' '}
                  and comes through this computer on its way.
                </p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={id('secret')}>Secret key</Label>
                <SecretInput
                  id={id('secret')}
                  value={secret}
                  onChange={setSecret}
                  placeholder="The key the backup was made with"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={id('owner')}>Owner in the backup</Label>
                  <Input
                    id={id('owner')}
                    value={owner}
                    onChange={(event) => setOwner(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={id('password')}>Their password</Label>
                  <SecretInput id={id('password')} value={password} onChange={setPassword} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={id('sudo')}>sudo password (optional)</Label>
                <SecretInput
                  id={id('sudo')}
                  value={sudo}
                  onChange={setSudo}
                  placeholder="Leave empty to use the saved login password"
                />
              </div>
            </fieldset>
            <div className="flex justify-end">
              <Button variant="destructive" disabled={!ready} onClick={() => void restore()}>
                {phase === 'restoring' && (
                  <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                )}
                Restore onto {target.nickname}
              </Button>
            </div>
          </>
        )}

        {steps.length > 0 && phase !== 'done' && (
          <ol aria-label="Restore steps" className="space-y-1">
            {steps.map((step) => (
              <li
                key={`${step.phase}:${step.title}`}
                className={cn(
                  'flex items-start gap-2 text-xs',
                  step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {step.status === 'running' ? (
                  <Spinner className="mt-0.5 h-3 w-3 shrink-0 motion-safe:animate-spin" />
                ) : step.status === 'done' ? (
                  <CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                ) : (
                  <CircleX className="mt-0.5 h-3 w-3 shrink-0" />
                )}
                <span>
                  {step.title}
                  {step.status === 'failed' ? ' (failed)' : ''}
                  {step.percent !== undefined && step.status === 'running'
                    ? ` ${step.percent}%`
                    : ''}
                  {step.detail ? `: ${step.detail}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}

        {(phase === 'pending' || phase === 'bringingUp' || phase === 'done') &&
          !waiting &&
          pending.isPending && (
            <div aria-busy="true" className="space-y-1.5">
              <Skeleton className="h-4 w-60" />
              <Skeleton className="h-3 w-80 max-w-full" />
            </div>
          )}
        {(phase === 'pending' || phase === 'bringingUp') &&
          !waiting &&
          !pending.isPending &&
          (pending.isError ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-destructive">
                The restored core did not say yet what it brings: {coreErrorMessage(pending.error)}
              </p>
              <Button size="sm" variant="soft" onClick={() => void pending.refetch()}>
                Ask again
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing from a backup waits on {target.nickname}.
            </p>
          ))}

        {showSummary && waiting && (
          <PendingSummary
            pending={waiting}
            move={moveAddresses}
            onMove={setMove}
            disabled={phase !== 'pending'}
            id={id}
          />
        )}
        {(phase === 'pending' || phase === 'bringingUp') && waiting && (
          <div className="flex justify-end">
            <Button disabled={phase === 'bringingUp'} onClick={() => void bringUp()}>
              {phase === 'bringingUp' && (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              )}
              Bring the server up
            </Button>
          </div>
        )}

        {bringUpStatus && <BringUpSteps status={bringUpStatus} />}

        {phase === 'done' && result && (
          <div className="space-y-3 text-sm" role="status">
            {bringUpStatus?.manualDns && bringUpStatus.manualDns.length > 0 && (
              <Notice tone="warning" icon={TriangleAlert} className="text-xs">
                Point these at the new address yourself, where their DNS is kept:{' '}
                {bringUpStatus.manualDns.join(', ')}.
              </Notice>
            )}
            {result.moved.length > 0 && (
              <div>
                <p className="text-xs font-medium text-foreground">Moved on this computer</p>
                <ul className="text-xs text-muted-foreground">
                  {result.moved.map((record) => (
                    <li key={`${record.area}:${record.name}`}>
                      {AREA[record.area]} {record.name}: from {record.from} to {record.to}
                      {record.trustReset
                        ? '. Its next connection asks you to trust the new server.'
                        : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.movedError && (
              <p className="text-xs text-destructive">
                Moving this computer's own records did not finish: {result.movedError}
              </p>
            )}
            {waiting && waiting.firewallRules.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  The backup has {waiting.firewallRules.length} firewall{' '}
                  {waiting.firewallRules.length === 1 ? 'rule' : 'rules'}. They are not applied
                  until you review them.
                </span>
                <Button size="sm" variant="soft" onClick={reviewFirewall}>
                  Review the firewall rules
                </Button>
              </div>
            )}
          </div>
        )}

        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </div>
      {sourceStepUp.dialog}
      {targetStepUp.dialog}
    </SecurityCard>
  );
}

function PendingSummary({
  pending,
  move,
  onMove,
  disabled,
  id,
}: {
  pending: PendingServerRestore;
  move: boolean;
  onMove: (value: boolean) => void;
  disabled: boolean;
  id: (name: string) => string;
}): React.JSX.Element {
  const facts: [string, React.ReactNode][] = [
    ['Volumes', pending.volumes],
    ['Images kept in the backup', pending.savedImages],
    ['Images pulled again', pending.pulledImages],
    ['Containers', pending.containers],
    ['Apps', pending.projects.length > 0 ? pending.projects.join(', ') : 'None'],
    ['Firewall rules', pending.firewallRules.length],
  ];
  return (
    <section aria-label="What the backup brings" className="space-y-3">
      <p className="text-sm text-foreground">
        The backup of {pending.hostName} from {dateAndTime(pending.createdAtUnixMs)} brings:
      </p>
      <dl className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {pending.liveCopy && (
        <Notice tone="warning" icon={TriangleAlert} className="text-xs">
          Its volumes were copied while the apps kept running. A database that was busy at that
          moment may come back inconsistent; check it once the apps are up.
        </Notice>
      )}
      {pending.addressChanges.length > 0 && (
        <div className="overflow-x-auto">
          <table aria-label="Address changes" className="w-full text-left text-xs">
            <thead>
              <tr>
                <th className={TABLE_HEAD}>Setting</th>
                <th className={TABLE_HEAD}>Name</th>
                <th className={TABLE_HEAD}>From</th>
                <th className={TABLE_HEAD}>To</th>
                <th className={TABLE_HEAD}>How</th>
              </tr>
            </thead>
            <tbody>
              {pending.addressChanges.map((change) => (
                <tr
                  key={`${change.area}:${change.target}:${change.from}`}
                  className="border-t border-foreground/[0.06]"
                >
                  <td className={TABLE_CELL}>{change.area}</td>
                  <td className={TABLE_CELL}>{change.target}</td>
                  <td className={cn(TABLE_CELL, 'font-mono')}>{change.from}</td>
                  <td className={cn(TABLE_CELL, 'font-mono')}>{change.to}</td>
                  <td className={TABLE_CELL}>
                    <Chip tone={change.automatic ? 'success' : 'warning'}>
                      {change.automatic ? 'Automatic' : 'Change by hand'}
                    </Chip>
                    {change.note && (
                      <span className="block text-muted-foreground">{change.note}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pending.oldAddresses.length > 0 && (
        <div className="flex items-start gap-2">
          <Checkbox
            id={id('move')}
            checked={move}
            disabled={disabled}
            onCheckedChange={(value) => onMove(value === true)}
          />
          <Label htmlFor={id('move')} className="font-normal leading-snug">
            Move what named the old address ({pending.oldAddresses.join(', ')}) to this server (
            {pending.newAddresses.join(', ') || 'its address'}), here and on the server
          </Label>
        </div>
      )}
    </section>
  );
}

function BringUpSteps({ status }: { status: ServerRestoreStatus }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <ol aria-label="Bringing the server up" className="space-y-1">
        {status.steps.map((step) => (
          <li key={step.name} className="flex items-start gap-2 text-xs text-muted-foreground">
            {step.state === 'uploading' || step.state === 'pending' ? (
              <Spinner className="mt-0.5 h-3 w-3 shrink-0 motion-safe:animate-spin" />
            ) : step.state === 'succeeded' ? (
              <CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" />
            ) : (
              <CircleX className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
            )}
            <span>
              {step.name}:{' '}
              {TARGET_STATE[step.state].label === 'Uploaded'
                ? 'done'
                : TARGET_STATE[step.state].label.toLowerCase()}
              {step.detail ? `. ${step.detail}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {status.state !== 'running' && (
        <p className="text-sm text-foreground">
          {status.state === 'succeeded'
            ? 'The server is back up.'
            : status.state === 'partlyFailed'
              ? 'The server is up, but not everything came back. The steps above say what did not.'
              : `Bringing the server up failed${status.error ? `: ${status.error}` : '.'}`}
        </p>
      )}
    </div>
  );
}
