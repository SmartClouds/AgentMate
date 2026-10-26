import type { DeployAccountInput } from '@shared/deployTypes';
import { CircleCheck, CircleInfo } from '@/components/icons';
import { SECTION_WELL } from '@/components/pageKit';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { cn } from '@/lib/utils';

/** 'create' sets up the owner of a new core; 'existing' signs in as an account the core has. */
export type AccountMode = 'create' | 'existing';

export interface AccountDraft {
  userName: string;
  password: string;
  confirm: string;
}

export const EMPTY_ACCOUNT: AccountDraft = { userName: '', password: '', confirm: '' };

/** The core's own rules (it checks common passwords too), so nothing hopeless is sent. */
const USER_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
export const MIN_PASSWORD = 12;

export function accountProblem(draft: AccountDraft, mode: AccountMode): string | null {
  if (!USER_NAME.test(draft.userName)) {
    return 'Choose a user name of letters, digits, dots, dashes, underscores or @.';
  }
  if (draft.password.length < MIN_PASSWORD) {
    return `The password needs at least ${MIN_PASSWORD} characters.`;
  }
  if (/[\r\n]/.test(draft.password)) return 'The password cannot contain a line break.';
  if (mode === 'create' && draft.password !== draft.confirm) return 'The two passwords differ.';
  if (
    mode === 'create' &&
    draft.userName.length >= 3 &&
    draft.password.toLowerCase().includes(draft.userName.toLowerCase())
  ) {
    return 'The password cannot contain the user name.';
  }
  return null;
}

export function toAccount(draft: AccountDraft): DeployAccountInput {
  return { userName: draft.userName, password: draft.password };
}

function Hint({ done, children }: { done: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <li
      className={cn(
        'flex items-center gap-1.5 text-xs',
        done ? 'text-success' : 'text-muted-foreground',
      )}
    >
      {done ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleInfo className="h-3.5 w-3.5" />}
      <span>
        {children}
        <span className="sr-only">{done ? ', done' : ', not yet'}</span>
      </span>
    </li>
  );
}

/** The account this computer signs in with, typed once during the install and never stored. */
export function AccountFields({
  mode,
  optional = false,
  draft,
  onChange,
  idPrefix,
}: {
  mode: AccountMode;
  /** An existing account that can also be given later, from the server card. */
  optional?: boolean;
  draft: AccountDraft;
  onChange: (draft: AccountDraft) => void;
  idPrefix: string;
}): React.JSX.Element {
  const set = (field: keyof AccountDraft) => (value: string) =>
    onChange({ ...draft, [field]: value });
  const note =
    mode === 'create'
      ? 'Runova signs in to the core with this account and a key only this computer has. The password is set up on the server over SSH and is not saved here unless you ask for that later; the core refuses passwords that are too common.'
      : optional
        ? 'This core is already set up. Enter your account there to enroll this computer, or leave it empty and do it later from the server card.'
        : null;
  return (
    // The well's edge is an inset ring, which a fieldset's own border would only fight.
    <fieldset className={cn(SECTION_WELL, 'space-y-3 p-4')}>
      <legend className="float-left mb-1 w-full text-sm font-medium text-foreground">
        {mode === 'create' ? 'Your account on the core' : 'Your account on this core'}
      </legend>
      {note && (
        <p className="clear-both max-w-xl text-xs leading-relaxed text-muted-foreground">{note}</p>
      )}
      <div className="clear-both grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-user`}>User name</Label>
          <Input
            id={`${idPrefix}-user`}
            value={draft.userName}
            onChange={(event) => set('userName')(event.target.value.trim())}
            autoComplete="off"
            spellCheck={false}
            placeholder="maria"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-password`}>Password</Label>
          <SecretInput
            id={`${idPrefix}-password`}
            value={draft.password}
            onChange={set('password')}
            placeholder={mode === 'create' ? 'At least 12 characters' : 'Password'}
          />
        </div>
        {mode === 'create' && (
          <div className="space-y-1.5 sm:col-start-2">
            <Label htmlFor={`${idPrefix}-confirm`}>Confirm the password</Label>
            <SecretInput
              id={`${idPrefix}-confirm`}
              value={draft.confirm}
              onChange={set('confirm')}
              placeholder="Type it again"
            />
          </div>
        )}
      </div>
      {mode === 'create' && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Password rules">
          <Hint done={draft.password.length >= MIN_PASSWORD}>
            {MIN_PASSWORD} characters or more
          </Hint>
          <Hint done={draft.password.length > 0 && draft.password === draft.confirm}>
            Both match
          </Hint>
        </ul>
      )}
    </fieldset>
  );
}
