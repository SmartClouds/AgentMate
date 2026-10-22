import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Key, Lock, RefreshCw, Shield, TriangleAlert } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { DeployCard } from './deployKit';
import { EnrollDialog } from './EnrollDialog';
import { RedeemCodeDialog } from './RedeemCodeDialog';
import { SignInDialog } from './SignInDialog';
import { TwoFactorDialog } from './TwoFactorDialog';

type Dialog = 'sign-in' | 'enroll' | 'redeem' | 'two-factor-on' | 'two-factor-off' | null;

/**
 * Whether this computer can manage the core, and the one step that gets it there: sign in, enroll
 * (again), or turn two-factor on. Each state says in words what it means.
 */
export function CoreAccessCard({ server }: { server: DeployServer }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [signingOut, setSigningOut] = useState(false);
  const access = useQuery({
    queryKey: queryKeys.deployAccess(server.id),
    queryFn: () => window.agentmat.deploy.access(server.id),
    retry: false,
    staleTime: 30_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployAccess(server.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployServers });
  };

  // Whatever a dialog ran into (a revoked device, an ended session) shows on the card afterwards.
  const closeDialog = () => {
    setDialog(null);
    refresh();
  };

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await window.agentmat.deploy.signOut(server.id);
      toast.success(`Signed out of ${server.nickname}.`);
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setSigningOut(false);
      refresh();
    }
  }

  async function forgetPassword(): Promise<void> {
    try {
      await window.agentmat.deploy.forgetPassword(server.id);
      toast.success(`Your password for ${server.nickname} is forgotten on this computer.`);
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      refresh();
    }
  }

  const state = access.data?.state;
  let body: React.ReactNode;
  if (access.isPending) {
    body = (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-8 w-32" />
      </div>
    );
  } else if (access.isError || state === 'unreachable') {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {access.data?.message ?? 'The core could not be asked who is signed in.'}
        </p>
        <Button size="sm" variant="soft" onClick={() => void access.refetch()}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  } else if (state === 'signed-in') {
    const user = access.data?.user;
    const twoFactor = user?.twoFactorEnabled ?? false;
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            Signed in as <span className="font-medium">{user?.userName ?? 'you'}</span>
            {user?.roles.map((role) => (
              <Chip key={role} tone="primary" className="capitalize">
                {role}
              </Chip>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {twoFactor
              ? 'Two-factor is on: signing in also takes a code from your authenticator app.'
              : 'Two-factor is off. Turn it on so a stolen password alone cannot get in.'}
          </p>
          {access.data?.passwordSaved && (
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              This computer remembers your password, so it answers the confirmation questions.
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto rounded-sm p-0 text-xs"
                onClick={() => void forgetPassword()}
              >
                Forget it
              </Button>
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant={twoFactor ? 'soft' : 'default'}
          onClick={() => setDialog(twoFactor ? 'two-factor-off' : 'two-factor-on')}
        >
          <Shield /> {twoFactor ? 'Turn off two-factor' : 'Turn on two-factor'}
        </Button>
        <Button size="sm" variant="soft" disabled={signingOut} onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    );
  } else if (state === 'needs-sign-in') {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
          {access.data?.message ?? 'Sign in to manage this core.'}
        </p>
        <Button size="sm" onClick={() => setDialog('sign-in')}>
          Sign in
        </Button>
      </div>
    );
  } else if (state === 'needs-re-enroll' || state === 'not-enrolled') {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-foreground">
          {state === 'needs-re-enroll' ? (
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          ) : (
            <Key className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          {state === 'needs-re-enroll'
            ? 'The core no longer accepts this computer: it was removed or revoked. Enroll it again to manage the server.'
            : 'This computer is not enrolled on this core yet.'}
        </p>
        {!server.dev && (
          <Button size="sm" onClick={() => setDialog('enroll')}>
            <Key /> {state === 'needs-re-enroll' ? 'Enroll again' : 'Enroll this computer'}
          </Button>
        )}
        {!server.dev && (
          <Button size="sm" variant="soft" onClick={() => setDialog('redeem')}>
            Use an enrollment code
          </Button>
        )}
      </div>
    );
  }

  return (
    <DeployCard
      icon={<Shield />}
      title="Your access"
      description="How this computer signs in to the core: its own key, your password, and optionally a code."
    >
      {body}
      <SignInDialog
        server={server}
        open={dialog === 'sign-in'}
        onOpenChange={(open) => (open ? setDialog('sign-in') : closeDialog())}
        onSignedIn={refresh}
      />
      <EnrollDialog
        server={server}
        open={dialog === 'enroll'}
        onOpenChange={(open) => (open ? setDialog('enroll') : closeDialog())}
        onEnrolled={refresh}
      />
      <RedeemCodeDialog
        server={server}
        open={dialog === 'redeem'}
        onOpenChange={(open) => (open ? setDialog('redeem') : closeDialog())}
        onEnrolled={refresh}
      />
      <TwoFactorDialog
        server={server}
        mode={dialog === 'two-factor-off' ? 'off' : 'on'}
        open={dialog === 'two-factor-on' || dialog === 'two-factor-off'}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        onChanged={refresh}
      />
    </DeployCard>
  );
}
