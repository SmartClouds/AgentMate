import { coreErrorMessage } from '@shared/coreErrors';
import type { UserInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { DEPLOY_ROLES, type DeployRole } from '@shared/deploySecurityTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useEffect, useId, useState } from 'react';
import { Lock, Spinner, UserPlus } from '@/components/icons';
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
import { SecretInput } from '@/components/ui/secret-input';
import { accountProblem, MIN_PASSWORD } from '../AccountFields';
import { ROLE_LABEL, ROLE_SUMMARY } from './format';

/**
 * Adding a user and resetting someone's password. Both take a password the core checks against
 * its own rules (length, common passwords, not the user name); the same rules are checked here
 * first so nothing hopeless is sent. The password goes to the core and is not kept.
 */

/** Runs the change; false when the user backed out of the step-up. Throws the core's refusal. */
type Submit<T> = (value: T) => Promise<boolean>;

function useSubmit<T>(submit: Submit<T>, close: () => void) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (value: T) => {
    setBusy(true);
    setProblem(null);
    try {
      if (await submit(value)) close();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return { problem, setProblem, busy, send };
}

function PasswordPair({
  idPrefix,
  label,
  password,
  confirm,
  onPassword,
  onConfirm,
}: {
  idPrefix: string;
  label: string;
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-password`}>{label}</Label>
        <SecretInput
          id={`${idPrefix}-password`}
          value={password}
          onChange={onPassword}
          placeholder={`At least ${MIN_PASSWORD} characters`}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-confirm`}>Confirm the password</Label>
        <SecretInput
          id={`${idPrefix}-confirm`}
          value={confirm}
          onChange={onConfirm}
          placeholder="Type it again"
        />
      </div>
    </div>
  );
}

function Problems({
  issue,
  problem,
}: {
  /** What the form still needs, shown once something was typed. */
  issue: string | null;
  /** What the core said. */
  problem: string | null;
}): React.JSX.Element {
  return (
    <>
      {issue && (
        <p role="status" className="text-xs text-muted-foreground">
          {issue}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </>
  );
}

export interface NewUser {
  userName: string;
  password: string;
  role: DeployRole;
}

export function CreateUserDialog({
  server,
  open,
  onOpenChange,
  onCreate,
}: {
  server: DeployServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: Submit<NewUser>;
}): React.JSX.Element {
  const id = useId();
  const [userName, setUserName] = useState('');
  const [role, setRole] = useState<DeployRole>('operator');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { problem, setProblem, busy, send } = useSubmit(onCreate, () => onOpenChange(false));

  useEffect(() => {
    if (!open) return;
    setUserName('');
    setRole('operator');
    setPassword('');
    setConfirm('');
    setProblem(null);
  }, [open, setProblem]);

  const issue = accountProblem({ userName, password, confirm }, 'create');
  const touched = userName !== '' || password !== '' || confirm !== '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!issue) void send({ userName, password, role });
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-primary" /> Add a user
            </DialogTitle>
            <DialogDescription>
              Someone else who may sign in to {server.nickname}. Once added, make them an enrollment
              code so their computer can join.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-user`}>User name</Label>
              <Input
                id={`${id}-user`}
                value={userName}
                onChange={(event) => setUserName(event.target.value.trim())}
                autoComplete="off"
                spellCheck={false}
                placeholder="sam"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-role`}>Role</Label>
              <Combobox
                id={`${id}-role`}
                searchable={false}
                options={DEPLOY_ROLES.map((option) => ({
                  value: option,
                  label: ROLE_LABEL[option],
                }))}
                value={role}
                onChange={(value) => setRole(value as DeployRole)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{ROLE_SUMMARY[role]}</p>
          <PasswordPair
            idPrefix={id}
            label="First password"
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
          />
          <p className="text-xs text-muted-foreground">
            Give it to them in person or another safe way. The core refuses passwords that are too
            common or contain the user name.
          </p>
          <Problems issue={touched ? issue : null} problem={problem} />
          <DialogFooter>
            <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || issue !== null}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Add the user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ResetPasswordDialog({
  user,
  open,
  onOpenChange,
  onReset,
}: {
  user: UserInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: Submit<string>;
}): React.JSX.Element {
  const id = useId();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { problem, setProblem, busy, send } = useSubmit(onReset, () => onOpenChange(false));

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setConfirm('');
    setProblem(null);
  }, [open, setProblem]);

  const name = user?.userName ?? '';
  const issue = accountProblem({ userName: name, password, confirm }, 'create');
  const touched = password !== '' || confirm !== '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!issue) void send(password);
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-primary" /> Reset {name}'s password
            </DialogTitle>
            <DialogDescription>
              Every session of {name}'s ends, on every computer; their devices stay enrolled. Give
              them the new password in person or another safe way.
            </DialogDescription>
          </DialogHeader>
          <PasswordPair
            idPrefix={id}
            label="New password"
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
          />
          <Problems issue={touched ? issue : null} problem={problem} />
          <DialogFooter>
            <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || issue !== null}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Reset the
              password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
