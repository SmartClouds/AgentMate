import type { DeployServer } from '@shared/deployTypes';
import { sshErrorMessage } from '@shared/sshErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CircleX, Key, RefreshCw, Rocket } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { installPhases, timeline } from '@/lib/deploy/setup';
import { queryKeys } from '@/lib/queryKeys';
import { withHostKeyTrust } from '@/lib/ssh/hostKeyTrust';
import { cn } from '@/lib/utils';
import { useDeploySetupStore } from '@/stores/deploySetupStore';
import {
  type AccountDraft,
  AccountFields,
  type AccountMode,
  accountProblem,
  EMPTY_ACCOUNT,
  toAccount,
} from './AccountFields';
import { DeployCard, Notice } from './deployKit';
import { PreflightChecklist, PreflightSkeleton } from './PreflightChecklist';
import { RedeemCodeDialog } from './RedeemCodeDialog';
import { SetupFailure } from './SetupFailure';
import { SetupTimeline } from './SetupTimeline';
import { SudoPasswordField } from './SudoPasswordField';

/**
 * Installing (or updating) the server core: a read-only check of the server first, then one
 * button. The sudo password is only asked for when the saved login cannot provide it.
 */
export function InstallPanel({
  server,
  onCancel,
}: {
  server: DeployServer;
  /** Backs out of an update, back to the health card. Absent for a first install. */
  onCancel?: () => void;
}): React.JSX.Element {
  const run = useDeploySetupStore((state) => state.runs[server.id]);
  const install = useDeploySetupStore((state) => state.install);
  const clear = useDeploySetupStore((state) => state.clear);
  const [password, setPassword] = useState('');
  const [askPassword, setAskPassword] = useState(false);
  const [account, setAccount] = useState<AccountDraft>(EMPTY_ACCOUNT);
  const [redeeming, setRedeeming] = useState(false);
  const queryClient = useQueryClient();
  const installRun = run?.kind === 'install' ? run : undefined;

  const preflightQuery = useQuery({
    queryKey: queryKeys.deployPreflight(server.id),
    queryFn: () => withHostKeyTrust(server.id, () => window.agentmat.deploy.preflight(server.id)),
    // Not while an install runs, but after one failed: "Try again" needs what the check found,
    // even when the page was left and opened again since.
    enabled: installRun?.status !== 'running',
    staleTime: 60_000,
    // A server that does not answer fails after its own deadlines. A silent retry would double
    // the wait before the panel says so, and "Check again" is right there.
    retry: false,
  });
  const preflight = preflightQuery.data;

  const sudoError =
    installRun?.status === 'failed' &&
    (installRun.errorCode === 'sudo-password-rejected' ||
      installRun.errorCode === 'sudo-password-required');
  const needsPassword =
    preflight?.sudo === 'password' && (!preflight.hasSavedPassword || askPassword || sudoError);
  const updating = server.core !== null || preflight?.installed != null;
  // A new core needs its owner; an existing one this computer is not on can be joined now or later.
  const accountMode: AccountMode | null = !preflight
    ? null
    : !preflight.installed
      ? 'create'
      : server.enrolled
        ? null
        : 'existing';
  const accountTouched = account.userName !== '' || account.password !== '';
  const accountIssue =
    accountMode === 'create' || (accountMode === 'existing' && accountTouched)
      ? accountProblem(account, accountMode)
      : null;
  const sendAccount = accountMode !== null && accountTouched && accountIssue === null;

  function start(): void {
    if (!preflight || accountIssue) return;
    void install(
      server.id,
      installPhases(preflight, sendAccount),
      needsPassword ? password : null,
      sendAccount ? toAccount(account) : undefined,
    );
  }

  function backToChecks(): void {
    clear(server.id);
    void preflightQuery.refetch();
  }

  const accountFields = accountMode && (
    <AccountFields
      mode={accountMode}
      optional={accountMode === 'existing'}
      draft={account}
      onChange={setAccount}
      idPrefix={`account-${server.id}`}
    />
  );

  const passwordField = needsPassword && preflight && (
    <SudoPasswordField
      id={`sudo-${server.id}`}
      user={preflight.loginUser}
      value={password}
      onChange={setPassword}
      onSubmit={start}
      errorCode={sudoError ? (installRun?.errorCode ?? null) : null}
    />
  );

  let body: React.ReactNode;
  if (installRun) {
    body = (
      <>
        <SetupTimeline
          label="Install steps"
          steps={timeline(installRun.planned, installRun.events)}
        />
        {installRun.status === 'running' && (
          <p className="text-xs text-muted-foreground">
            You can leave this page. The install keeps going and shows up here again.
          </p>
        )}
        {installRun.status === 'failed' && (
          <>
            <SetupFailure message={installRun.error ?? 'The install stopped.'} />
            {accountIssue !== null && accountFields}
            {passwordField}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={start}
                disabled={!preflight || (needsPassword && !password) || accountIssue !== null}
              >
                <RefreshCw /> Try again
              </Button>
              <Button size="sm" variant="soft" onClick={backToChecks}>
                Check the server again
              </Button>
            </div>
          </>
        )}
      </>
    );
  } else if (preflightQuery.isPending) {
    body = <PreflightSkeleton serverName={server.nickname} />;
  } else if (preflightQuery.isError) {
    body = (
      <>
        <SetupFailure message={sshErrorMessage(preflightQuery.error)} />
        <Button size="sm" variant="soft" onClick={() => void preflightQuery.refetch()}>
          <RefreshCw /> Check again
        </Button>
      </>
    );
  } else if (preflight) {
    const blocked = preflight.problems.length > 0;
    const available = preflight.available;
    const label = !available
      ? 'Install the server core'
      : preflight.installed?.version === available
        ? `Reinstall core ${available}`
        : preflight.installed
          ? `Update to core ${available}`
          : `Install core ${available}`;
    body = (
      <>
        <PreflightChecklist preflight={preflight} />
        {preflight.installed && !server.enrolled && (
          <Notice icon={Key}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="min-w-0 flex-1">
                The core already runs here. With an enrollment code from one of its Owners, this
                computer can join it without sudo.
              </p>
              <Button size="sm" variant="soft" onClick={() => setRedeeming(true)}>
                <Key /> Join with a code
              </Button>
            </div>
          </Notice>
        )}
        {blocked && (
          <Notice role="alert" tone="destructive" icon={CircleX}>
            <p className="font-medium">This server cannot take the core yet</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              {preflight.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Notice>
        )}
        {!blocked && accountFields}
        {!blocked && passwordField}
        {!blocked && !needsPassword && preflight.sudo === 'password' && (
          <p className="text-xs text-muted-foreground">
            sudo will use the saved login password.{' '}
            <button
              type="button"
              className="cursor-pointer rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setAskPassword(true)}
            >
              Use a different password
            </button>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={start}
            disabled={blocked || (needsPassword && !password) || accountIssue !== null}
          >
            <Rocket /> {label}
          </Button>
          {!blocked && accountIssue && accountTouched && (
            <p className="text-xs text-muted-foreground" role="status">
              {accountIssue}
            </p>
          )}
          <Button
            variant="soft"
            disabled={preflightQuery.isFetching}
            onClick={() => void preflightQuery.refetch()}
          >
            <RefreshCw className={cn(preflightQuery.isFetching && 'motion-safe:animate-spin')} />
            Check again
          </Button>
          {onCancel && (
            <Button variant="soft" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </>
    );
  }

  return (
    <DeployCard
      icon={<Rocket />}
      title={updating ? 'Update or reinstall the server core' : 'Install the server core'}
      description={
        updating
          ? 'The running core keeps working until the new one is ready. If the new one does not start, the server goes back to the one it has now.'
          : `A small service that runs on ${server.nickname} so AgentMate can show what happens there and act on it. It only listens on a private socket, so no port is opened: the app reaches it through your SSH login.`
      }
      bodyClassName="space-y-4"
    >
      {body}
      <RedeemCodeDialog
        server={server}
        open={redeeming}
        onOpenChange={setRedeeming}
        onEnrolled={() => {
          // The app now knows this core, so the page moves on from the install.
          void queryClient.invalidateQueries({ queryKey: queryKeys.deployServers });
          void queryClient.invalidateQueries({ queryKey: queryKeys.deployAccess(server.id) });
        }}
      />
    </DeployCard>
  );
}
