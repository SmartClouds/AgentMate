import type { RecaptchaAccount } from '@shared/deployRecaptchaTypes';
import { recaptchaErrorMessage } from '@shared/recaptchaErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Lock } from '@/components/icons';
import { GLASS_CARD, Notice, Problem } from '@/components/pageKit';
import { SshVaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { KeysCard } from './KeysCard';
import { ProjectStep } from './ProjectStep';
import { RecaptchaMark } from './RecaptchaMark';
import { OwnClientForm, SignInPanel, SignInWaiting, useGoogleSignIn } from './SignInPanel';
import { UsageCard } from './UsageCard';

/** The page's first card, drawn like a server's header, with the account menu on the right. */
function RecaptchaHeader({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'flex shrink-0 flex-wrap items-center gap-3 px-4 py-3')}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#4a8af4]/12 shadow-[0_0_28px_-12px_#4a8af4]">
        <RecaptchaMark className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-semibold leading-tight tracking-tight text-foreground">
          reCAPTCHA
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Keys that keep bots off your sites, kept in your Google Cloud.
        </p>
      </div>
      {children}
    </div>
  );
}

function Avatar({ email }: { email: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#4a8af4]/15 text-[11px] font-semibold uppercase text-[#4a8af4]"
    >
      {email.slice(0, 1)}
    </span>
  );
}

function AccountMenu({
  account,
  accounts,
  onSwitch,
  onChangeProject,
  onAddAccount,
  onSignOut,
}: {
  account: RecaptchaAccount;
  accounts: RecaptchaAccount[];
  onSwitch: (accountId: string) => void;
  onChangeProject: () => void;
  onAddAccount: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const others = accounts.filter((one) => one.id !== account.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="soft"
          aria-label={`Google account ${account.email}`}
          className="h-auto max-w-full gap-2 py-1.5 pl-1.5 pr-3"
        >
          <Avatar email={account.email} />
          <span className="min-w-0 text-left">
            <span className="block truncate text-xs font-medium text-foreground">
              {account.email}
            </span>
            <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
              {account.projectId ?? 'No project yet'}
            </span>
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {others.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Switch account
            </DropdownMenuLabel>
            {others.map((other) => (
              <DropdownMenuItem key={other.id} onSelect={() => onSwitch(other.id)}>
                <Avatar email={other.email} /> {other.email}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {account.projectId && (
          <DropdownMenuItem onSelect={onChangeProject}>Change project</DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onAddAccount}>Add another Google account</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut} className="text-destructive focus:text-destructive">
          Sign out of {account.email}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Google stopped accepting an account's sign-in: say so and offer the one fix. */
function SignInAgain({
  account,
  runovaClient,
}: {
  account: RecaptchaAccount;
  runovaClient: boolean;
}): React.JSX.Element {
  const { signIn, waiting, problem } = useGoogleSignIn(() => undefined);
  const [ownOpen, setOwnOpen] = useState(false);
  const own = account.clientMode === 'own' || !runovaClient;
  return (
    <div className="flex flex-col gap-2">
      <Notice
        tone="warning"
        className="items-center"
        action={
          !waiting &&
          !ownOpen && (
            <Button
              size="sm"
              onClick={() => (own ? setOwnOpen(true) : void signIn({ mode: 'runova' }))}
            >
              Sign in again
            </Button>
          )
        }
      >
        Google no longer accepts the sign-in for {account.email}. This happens when access was
        removed in the Google account or the password changed. Sign in again to keep managing its
        keys.
      </Notice>
      {problem && <Notice tone="destructive">{problem}</Notice>}
      {waiting && !ownOpen && <SignInWaiting />}
      {ownOpen && (
        <div className={cn(GLASS_CARD, 'p-4')}>
          <OwnClientForm waiting={waiting} onSubmit={(input) => void signIn(input)} />
        </div>
      )}
    </div>
  );
}

function RecaptchaSkeleton(): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-busy="true">
      <RecaptchaHeader>
        <Skeleton className="h-10 w-52 rounded-full" />
      </RecaptchaHeader>
      <div className={cn(GLASS_CARD, 'space-y-3 p-4')}>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </div>
  );
}

/**
 * The reCAPTCHA page in Deploy (E40): sign in to Google once, pick or make a Google Cloud project,
 * and manage that project's keys. Like the Cloudflare page it belongs to an account, not a server,
 * so it opens from its own row in the server rail, and every step is drawn on the page itself.
 */
export function RecaptchaView(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [view, setView] = useState<'keys' | 'project' | 'add'>('keys');
  const [unlockOpen, setUnlockOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: queryKeys.recaptchaStatus,
    queryFn: () => window.runova.deployRecaptcha.status(),
  });

  if (statusQuery.isPending) return <RecaptchaSkeleton />;

  if (statusQuery.isError) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <RecaptchaHeader />
        <Problem
          message={recaptchaErrorMessage(statusQuery.error)}
          onRetry={() => void statusQuery.refetch()}
        />
      </div>
    );
  }

  const status = statusQuery.data;
  const unlockDialog = (
    <SshVaultUnlockDialog
      open={unlockOpen}
      onOpenChange={setUnlockOpen}
      mode="unlock"
      onUnlocked={() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sshVaultStatus });
        void queryClient.invalidateQueries({ queryKey: ['recaptcha'] });
      }}
    />
  );

  if (status.locked) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <RecaptchaHeader />
        <Notice
          tone="warning"
          icon={Lock}
          className="items-center"
          action={
            <Button size="sm" onClick={() => setUnlockOpen(true)}>
              Unlock
            </Button>
          }
        >
          Your saved servers are locked with a passkey, and your Google sign-in with them. Unlock
          them to manage your reCAPTCHA keys.
        </Notice>
        {unlockDialog}
      </div>
    );
  }

  const signedIn = (account: RecaptchaAccount) => {
    setAccountId(account.id);
    setView('keys');
  };

  const account = status.accounts.find((one) => one.id === accountId) ?? status.accounts[0] ?? null;

  if (!account || view === 'add') {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <RecaptchaHeader />
        <SignInPanel
          runovaClient={status.runovaClient}
          onSignedIn={signedIn}
          onBack={account ? () => setView('keys') : undefined}
        />
      </div>
    );
  }

  async function signOut(target: RecaptchaAccount): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Sign out of ${target.email}?`,
      description:
        'Runova forgets this Google sign-in and asks Google to drop it. Your keys stay in Google Cloud and keep working on your sites.',
      confirmLabel: 'Sign out',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.deployRecaptcha.removeAccount(target.id);
      toast.success(`Signed out of ${target.email}.`);
      setAccountId(null);
      setView('keys');
      queryClient.removeQueries({ queryKey: queryKeys.recaptchaData });
      await queryClient.invalidateQueries({ queryKey: queryKeys.recaptchaStatus });
    } catch (error) {
      toast.error(recaptchaErrorMessage(error));
    }
  }

  const project = account.projectId
    ? { accountId: account.id, projectId: account.projectId }
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <RecaptchaHeader>
        <AccountMenu
          account={account}
          accounts={status.accounts}
          onSwitch={(id) => {
            setAccountId(id);
            setView('keys');
          }}
          onChangeProject={() => setView('project')}
          onAddAccount={() => setView('add')}
          onSignOut={() => void signOut(account)}
        />
      </RecaptchaHeader>
      {account.needsSignIn ? (
        <SignInAgain key={account.id} account={account} runovaClient={status.runovaClient} />
      ) : !project || view === 'project' ? (
        <ProjectStep
          key={account.id}
          account={account}
          onDone={() => setView('keys')}
          onCancel={project ? () => setView('keys') : undefined}
        />
      ) : (
        <>
          <UsageCard key={`usage:${account.id}:${project.projectId}`} project={project} />
          <KeysCard key={`keys:${account.id}:${project.projectId}`} project={project} />
        </>
      )}
    </div>
  );
}
