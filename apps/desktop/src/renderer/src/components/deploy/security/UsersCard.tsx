import { coreErrorMessage } from '@shared/coreErrors';
import type { UserInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { DEPLOY_ROLES, type DeployRole } from '@shared/deploySecurityTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Ban,
  CircleCheck,
  EllipsisVertical,
  Key,
  Lock,
  LockOpen,
  Trash2,
  UserPlus,
  Users,
} from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { EnrollmentCodeDialog } from './EnrollmentCodeDialog';
import { ago, clockTime, isRole, ROLE_LABEL, ROLE_SUMMARY, roleLabel, withArticle } from './format';
import { CARD_ROWS, LoadFailure, RowsSkeleton, SecurityCard } from './SecurityCard';
import { CreateUserDialog, ResetPasswordDialog } from './UserDialogs';
import { useStepUp } from './useStepUp';

type OpenDialog =
  | { kind: 'create' }
  | { kind: 'reset'; user: UserInfo }
  | { kind: 'code'; userName: string; self: boolean }
  | null;

function devices(count: number): string {
  if (count === 0) return 'No devices';
  return count === 1 ? '1 device' : `${count} devices`;
}

const locked = (user: UserInfo) => !user.disabled && user.lockedOutUntilUnixMs !== undefined;

/** Status in words with an icon beside it, never by colour alone. */
function UserStatus({ user }: { user: UserInfo }): React.JSX.Element {
  if (user.disabled) {
    return (
      <Chip tone="destructive">
        <Ban />
        Disabled
      </Chip>
    );
  }
  if (locked(user)) {
    return (
      <SimpleTooltip label="Too many wrong passwords. It unlocks by itself, or when an Owner unlocks it.">
        <Chip tone="warning">
          <Lock />
          {`Locked until ${clockTime(user.lockedOutUntilUnixMs ?? 0)}`}
        </Chip>
      </SimpleTooltip>
    );
  }
  return (
    <Chip tone="success" dot>
      Active
    </Chip>
  );
}

/**
 * Who can sign in to the core, for its Owners: each user's role, second factor, lockout and last
 * sign-in, and the changes an Owner makes (role, disable, password, enrollment code, removal).
 * Every change goes through the core's step-up, and the core checks every rule again, such as
 * never leaving the core without an Owner.
 */
export function UsersCard({ server }: { server: DeployServer }): React.JSX.Element {
  const queryClient = useQueryClient();
  const stepUp = useStepUp(server);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const users = useQuery({
    queryKey: queryKeys.deployUsers(server.id),
    queryFn: () => window.runova.deploySecurity.listUsers(server.id),
    retry: false,
  });
  const api = window.runova.deploySecurity;

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.deploySecurity(server.id) });

  /** One change behind the step-up; a refusal shows in the core's own words. */
  async function change(work: () => Promise<unknown>, done: string): Promise<void> {
    try {
      const finished = await stepUp.run(async () => {
        await work();
        return true;
      });
      if (finished) toast.success(done);
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      refresh();
    }
  }

  async function changeRole(user: UserInfo, role: DeployRole): Promise<void> {
    if (role === user.role) return;
    const confirmed = await confirmDialog({
      title: `Make ${user.userName} ${withArticle(role)}?`,
      description: `${ROLE_SUMMARY[role]} ${user.current ? 'Your' : `${user.userName}'s`} open connections to the core close and come back with the new role.`,
      warning:
        user.current && user.role === 'owner' && role !== 'owner'
          ? 'You can no longer manage users once this is done.'
          : undefined,
      confirmLabel: 'Change the role',
    });
    if (!confirmed) return;
    await change(
      () => api.setUserRole({ serverId: server.id, userId: user.id, role }),
      `${user.userName} is ${withArticle(role)} now.`,
    );
    if (user.current) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployAccess(server.id) });
    }
  }

  async function disable(user: UserInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Disable ${user.userName}?`,
      description: `${user.userName} is signed out everywhere and cannot sign in until an Owner enables the account again. Their devices stay enrolled.`,
      confirmLabel: 'Disable',
      variant: 'destructive',
    });
    if (!confirmed) return;
    await change(
      () => api.setUserDisabled({ serverId: server.id, userId: user.id, disabled: true }),
      `${user.userName} is disabled and signed out everywhere.`,
    );
  }

  const enable = (user: UserInfo) =>
    change(
      () => api.setUserDisabled({ serverId: server.id, userId: user.id, disabled: false }),
      `${user.userName} can sign in again.`,
    );

  async function remove(user: UserInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove ${user.userName}?`,
      description: `${user.userName}'s account goes, with every device, session and enrollment code of theirs. The audit trail keeps what they did.`,
      warning: 'This cannot be undone.',
      confirmLabel: 'Remove the user',
      variant: 'destructive',
      typeToConfirm: user.userName,
    });
    if (!confirmed) return;
    await change(
      () => api.deleteUser({ serverId: server.id, userId: user.id }),
      `${user.userName} is removed.`,
    );
  }

  let body: React.ReactNode;
  if (users.isPending) {
    body = <RowsSkeleton />;
  } else if (users.isError) {
    body = (
      <LoadFailure message={coreErrorMessage(users.error)} onRetry={() => void users.refetch()} />
    );
  } else {
    body = (
      <ul aria-label="Users" className={CARD_ROWS}>
        {users.data.map((user) => (
          <li
            key={user.id}
            aria-label={user.userName}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {user.userName}
                </span>
                {user.current && <Chip tone="primary">You</Chip>}
                <Chip>{roleLabel(user.role)}</Chip>
              </div>
              <p className="text-xs text-muted-foreground">
                {[
                  user.twoFactorEnabled ? 'Two-factor on' : 'Two-factor off',
                  user.lastSignInAtUnixMs === undefined
                    ? 'Never signed in'
                    : `Signed in ${ago(user.lastSignInAtUnixMs)}`,
                  devices(user.devices),
                ].join(' · ')}
              </p>
            </div>
            <UserStatus user={user} />
            <DropdownMenu>
              <SimpleTooltip label="Actions">
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Actions for ${user.userName}`}
                  >
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
              </SimpleTooltip>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Role</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={user.role ?? ''}
                  onValueChange={(role) => {
                    if (isRole(role)) void changeRole(user, role);
                  }}
                >
                  {DEPLOY_ROLES.map((role) => (
                    <DropdownMenuRadioItem key={role} value={role}>
                      {ROLE_LABEL[role]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    setDialog({ kind: 'code', userName: user.userName, self: user.current })
                  }
                >
                  <Key className="h-3.5 w-3.5" /> Enrollment code
                </DropdownMenuItem>
                {!user.current && (
                  <>
                    <DropdownMenuItem onSelect={() => setDialog({ kind: 'reset', user })}>
                      <Lock className="h-3.5 w-3.5" /> Reset the password
                    </DropdownMenuItem>
                    {locked(user) && (
                      <DropdownMenuItem onSelect={() => void enable(user)}>
                        <LockOpen className="h-3.5 w-3.5" /> Unlock
                      </DropdownMenuItem>
                    )}
                    {user.disabled ? (
                      <DropdownMenuItem onSelect={() => void enable(user)}>
                        <CircleCheck className="h-3.5 w-3.5" /> Enable
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => void disable(user)}>
                        <Ban className="h-3.5 w-3.5" /> Disable
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem tone="danger" onSelect={() => void remove(user)}>
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <SecurityCard
      icon={<Users />}
      title="Users"
      description={`Who can sign in to ${server.nickname}, and what each of them may do. Only Owners see this list.`}
      actions={
        <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
          <UserPlus className="h-3.5 w-3.5" /> Add a user
        </Button>
      }
    >
      {body}
      <CreateUserDialog
        server={server}
        open={dialog?.kind === 'create'}
        onOpenChange={(open) => !open && setDialog(null)}
        onCreate={async (input) => {
          const created = await stepUp.run(() => api.createUser({ serverId: server.id, ...input }));
          if (!created) return false;
          refresh();
          toast.success(`${created.userName} can sign in to ${server.nickname} now.`, {
            description: 'Make them an enrollment code so their computer can join.',
            action: {
              label: 'Make a code',
              onClick: () => setDialog({ kind: 'code', userName: created.userName, self: false }),
            },
          });
          return true;
        }}
      />
      <ResetPasswordDialog
        user={dialog?.kind === 'reset' ? dialog.user : null}
        open={dialog?.kind === 'reset'}
        onOpenChange={(open) => !open && setDialog(null)}
        onReset={async (password) => {
          if (dialog?.kind !== 'reset') return false;
          const target = dialog.user;
          const done = await stepUp.run(async () => {
            await api.resetUserPassword({ serverId: server.id, userId: target.id, password });
            return true;
          });
          if (!done) return false;
          refresh();
          toast.success(
            `${target.userName}'s password is reset, and every session of theirs ended.`,
          );
          return true;
        }}
      />
      <EnrollmentCodeDialog
        server={server}
        userName={dialog?.kind === 'code' ? dialog.userName : ''}
        self={dialog?.kind === 'code' && dialog.self}
        open={dialog?.kind === 'code'}
        onOpenChange={(open) => !open && setDialog(null)}
        run={stepUp.run}
      />
      {stepUp.dialog}
    </SecurityCard>
  );
}
