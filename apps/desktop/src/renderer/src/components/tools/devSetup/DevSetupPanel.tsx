import { type ChecklistRow, DEV_STACKS, getDevItem, overallFraction } from '@runova/core';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GLASS_CARD, LoadFailure, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  describeInstallAll,
  describeRow,
  describeRun,
  describeUpdateAll,
  type RowAction,
  type RowView,
} from './devSetupView';
import { InstallLogDrawer } from './InstallLogDrawer';
import { SetupSummary } from './SetupSummary';
import { StackChecklist } from './StackChecklist';
import { StackChips } from './StackChips';
import { useDevSetup } from './useDevSetup';

/** The Microsoft Store page for App Installer, which is what provides winget. */
const APP_INSTALLER_URL = 'https://apps.microsoft.com/detail/9nblggh4nns1';

/** Stand-in rows while the machine is being looked at, so the page keeps its shape. */
function ChecklistSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Looking at this computer"
      className={cn(
        GLASS_CARD,
        'flex flex-col [&>div+div]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]',
      )}
    >
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="mt-0.5 h-4 w-4 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-48 max-w-full" />
          </div>
          <Skeleton className="h-7 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Agent Tools > Dev Setup: pick what you build, see what this machine has and lacks, and get the
 * rest in place. Everything is laid out here; what each row says and offers comes from
 * `describeRow`, and the data and actions come from `useDevSetup`.
 */
export function DevSetupPanel(): React.JSX.Element {
  const devSetup = useDevSetup();
  const { checklist, environment, job, plan, updatePlan } = devSetup;
  // A link from elsewhere in the app (Studio's "Install ffmpeg") names the stack it needs.
  const [searchParams] = useSearchParams();
  const askedStack = searchParams.get('stack');
  const { showStack, stacksLoaded } = devSetup;
  // Once per link: showStack changes with every choice, and the person may switch it off again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: showStack is left out on purpose
  useEffect(() => {
    if (askedStack && stacksLoaded) showStack(askedStack);
  }, [askedStack, stacksLoaded]);
  const updating = job.intent === 'update';
  const [logFor, setLogFor] = useState<string | null>(null);

  const nameOf = (id: string): string =>
    checklist?.rows.find((row) => row.item.id === id)?.name ?? getDevItem(id)?.name ?? id;

  const viewOf = (row: ChecklistRow): RowView =>
    describeRow(row, { os: environment?.os ?? 'win32', inAppInstall: true, nameOf });

  // A failure opens the log by itself, since the reason on the row is rarely the whole story. It
  // does so once per failure, so closing the log is not undone by the next update.
  const failedIds = Object.entries(job.items)
    .filter(([, one]) => one.status === 'failed')
    .map(([id]) => id);
  const failedKey = failedIds.join(',');
  const alreadyShown = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: failedKey stands for failedIds
  useEffect(() => {
    for (const id of [...alreadyShown.current]) {
      if (!failedIds.includes(id)) alreadyShown.current.delete(id);
    }
    const fresh = failedIds.filter((id) => !alreadyShown.current.has(id));
    for (const id of fresh) alreadyShown.current.add(id);
    const latest = fresh.at(-1);
    if (latest) setLogFor(latest);
  }, [failedKey]);

  // What a screen reader is told. Only results, once each: progress updates many times a second
  // and would talk over everything else, and the row and the summary already show it.
  const [announcement, setAnnouncement] = useState('');
  const told = useRef<{
    jobId: string | null;
    done: number;
    failed: Set<string>;
    cancelled: boolean;
  }>({
    jobId: null,
    done: 0,
    failed: new Set(),
    cancelled: false,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: failedKey stands for failedIds
  useEffect(() => {
    const memory = told.current;
    if (memory.jobId !== job.jobId) {
      told.current = { jobId: job.jobId, done: 0, failed: new Set(), cancelled: false };
    }
    const spoken = told.current;
    const messages: string[] = [];
    for (const id of job.completed.slice(spoken.done)) {
      messages.push(`${nameOf(id)} ${job.intent === 'update' ? 'updated' : 'installed'}.`);
    }
    spoken.done = job.completed.length;
    for (const id of failedIds) {
      if (spoken.failed.has(id)) continue;
      spoken.failed.add(id);
      const kind = job.items[id]?.intent === 'update' ? 'updated' : 'installed';
      messages.push(`${nameOf(id)} could not be ${kind}.`);
    }
    if (job.cancelled && !spoken.cancelled) {
      spoken.cancelled = true;
      messages.push(job.intent === 'update' ? 'Update cancelled.' : 'Install cancelled.');
    }
    if (messages.length > 0) setAnnouncement(messages.join(' '));
  }, [job.jobId, job.completed, job.cancelled, job.intent, failedKey]);

  function handleAction(row: ChecklistRow, view: RowView, action: RowAction): void {
    const id = row.item.id;
    switch (action.kind) {
      case 'install':
        void devSetup.install([id]);
        break;
      case 'update':
        // A tool below its minimum is "outdated" and is brought up through the install path, which
        // knows what it needs first. One that is ready and merely behind is an update.
        if (row.state.kind === 'installed') void devSetup.update([id]);
        else void devSetup.install([id]);
        break;
      case 'terminal-install':
        if (view.terminalCommand) {
          devSetup.openInTerminal({
            id,
            name: row.name,
            command: view.terminalCommand,
            intent: row.state.kind === 'installed' ? 'update' : 'install',
          });
        }
        break;
      case 'open-link':
        if (action.url) void window.runova.shell.openExternal(action.url);
        break;
      case 'retry':
        // A failed install is run again; a check that failed is simply checked again.
        if (row.state.kind === 'failed') void devSetup.install([id]);
        else devSetup.recheck(id);
        break;
      case 'recheck':
        devSetup.recheck(id);
        break;
      case 'cancel':
        devSetup.cancel();
        break;
      case 'unqueue':
        devSetup.cancel(id);
        break;
      case 'add-to-path':
        void devSetup.addToPath({ id, name: row.name });
        break;
    }
  }

  const wingetMissing =
    environment?.os === 'win32' && !environment.packageManagers.includes('winget');
  const noLinuxManager = environment?.os === 'linux' && environment.packageManagers.length === 0;
  const updateAllView = updatePlan ? describeUpdateAll(updatePlan) : null;
  // With nothing left to install, the one button that has work to do is Update all, and a disabled
  // "Install all missing" next to it would only be in the way.
  const nothingMissing =
    plan !== undefined &&
    plan.steps.length === 0 &&
    plan.manual.length === 0 &&
    plan.deferred.length === 0;
  const installAll =
    plan && !(nothingMissing && updateAllView) ? describeInstallAll(plan) : undefined;

  return (
    <div className="@container/devsetup flex flex-col gap-2">
      <StackChips stacks={DEV_STACKS} selected={devSetup.stacks} onToggle={devSetup.toggleStack} />

      {devSetup.environmentFailed ? (
        <LoadFailure message="Could not look at this computer." retry={devSetup.retryEnvironment} />
      ) : !checklist ? (
        <ChecklistSkeleton />
      ) : (
        <>
          <div role="status" aria-label="Install updates" aria-live="polite" className="sr-only">
            {announcement}
          </div>
          <SetupSummary
            summary={checklist.summary}
            onRecheckAll={devSetup.recheckAll}
            installAll={
              installAll && {
                label: installAll.label,
                disabled: installAll.disabled,
                hint: installAll.hint,
                note: installAll.note,
                onClick: () => void devSetup.installAll(),
              }
            }
            updateAll={
              updateAllView
                ? {
                    label: updateAllView.label,
                    disabled: updateAllView.disabled,
                    hint: updateAllView.hint,
                    note: updateAllView.note,
                    onClick: () => void devSetup.updateAll(),
                  }
                : undefined
            }
            updatesStatus={devSetup.updatesStatus}
            run={
              job.running
                ? {
                    ...describeRun(job, nameOf),
                    fraction: overallFraction(job),
                    onCancel: () => devSetup.cancel(),
                    cancelLabel: updating ? 'Cancel update' : undefined,
                  }
                : undefined
            }
          />

          {wingetMissing && (
            <Notice
              tone="warning"
              action={
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => void window.runova.shell.openExternal(APP_INSTALLER_URL)}
                >
                  Open the Microsoft Store page
                </Button>
              }
            >
              winget was not found, so installs open a download page instead of running here.
              Install App Installer from the Microsoft Store to get one-click installs.
            </Notice>
          )}
          {noLinuxManager && (
            <Notice tone="warning">
              No supported package manager was found (apt, dnf or pacman), so installs open a
              download page instead.
            </Notice>
          )}
          {job.completed.length > 0 && (
            <Notice tone="neutral">
              {updating
                ? 'Terminals that are already open will not see the new versions. Open a new one.'
                : 'Terminals that are already open will not see the new tools. Open a new one.'}
            </Notice>
          )}
          {job.restartAdvised && (
            <Notice tone="warning">
              Restart your computer to finish setting up what you just installed.
            </Notice>
          )}

          {logFor && (
            <InstallLogDrawer
              logs={job.logs}
              nameOf={nameOf}
              selected={logFor}
              onSelect={setLogFor}
              onClose={() => setLogFor(null)}
            />
          )}

          {checklist.groups.map((group) => (
            <StackChecklist
              key={group.stack.id}
              group={group}
              viewOf={viewOf}
              onAction={handleAction}
              onTerminal={(row, view) => {
                if (view.terminalCommand) {
                  devSetup.openInTerminal({
                    id: row.item.id,
                    name: row.name,
                    command: view.terminalCommand,
                  });
                }
              }}
              onCopy={(row, view) => {
                if (view.terminalCommand) {
                  void devSetup.copyCommand({ name: row.name, command: view.terminalCommand });
                }
              }}
              onShowLog={(row) => setLogFor(row.item.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}
