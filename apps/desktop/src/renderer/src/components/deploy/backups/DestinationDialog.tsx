import { coreErrorMessage } from '@shared/coreErrors';
import { telegramPartNote } from '@shared/deploy/backupSchedule';
import type {
  BackupDestinationInfo,
  BackupDestinationKind,
  BackupDestinationTest,
  SaveBackupDestinationRequest,
  TelegramLoginState,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, CloudUpload, Lock, Send, Spinner, TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/pageKit';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { CODE_WELL } from '../security/SecurityCard';
import type { StepUp } from '../security/useStepUp';
import { KIND_LABEL } from './format';

/**
 * Adding or changing a destination (E28), one form per kind. SFTP is tested before it is saved:
 * the server shows its host key and the user trusts it, so the core never talks to a server it
 * was not told to. FTPS shows a certificate it cannot check the same way, for pinning. Google
 * Drive and OneDrive sign in through the browser with the user's own OAuth client; Telegram signs
 * in to the user's own account with a code, then the cloud password when it has one.
 */

const KINDS = (Object.keys(KIND_LABEL) as BackupDestinationKind[]).map((value) => ({
  value,
  label: KIND_LABEL[value],
}));

const DEFAULT_FOLDER = 'AgentMate backups';
const MB = 1024 * 1024;

interface Form {
  name: string;
  kind: BackupDestinationKind;
  path: string;
  host: string;
  port: string;
  userName: string;
  password: string;
  auth: 'password' | 'key';
  privateKey: string;
  passphrase: string;
  tls: boolean;
  pinned: string;
  clientId: string;
  clientSecret: string;
  folderName: string;
  partMb: string;
  apiId: string;
  apiHash: string;
  phone: string;
}

function formOf(destination: BackupDestinationInfo | null): Form {
  const settings = destination?.settings ?? {};
  return {
    name: destination?.name ?? '',
    kind: destination?.kind ?? 'folder',
    path: settings.path ?? '',
    host: settings.host ?? '',
    port: settings.port ? String(settings.port) : '',
    userName: settings.userName ?? '',
    password: '',
    auth: 'password',
    privateKey: '',
    passphrase: '',
    tls: settings.tls ?? true,
    pinned: settings.hostKeySha256 ?? '',
    clientId: settings.clientId ?? '',
    clientSecret: '',
    folderName: settings.folderName ?? DEFAULT_FOLDER,
    partMb: destination?.maxPartBytes ? String(Math.round(destination.maxPartBytes / MB)) : '',
    apiId: settings.apiId ? String(settings.apiId) : '',
    apiHash: '',
    phone: '',
  };
}

const defaultPort = (kind: BackupDestinationKind) => (kind === 'sftp' ? 22 : 21);

/** The request the core takes, from the form. Empty credentials keep the stored ones. */
export function requestOf(form: Form, id?: string): SaveBackupDestinationRequest {
  const base = { ...(id ? { id } : {}), name: form.name.trim(), kind: form.kind };
  const part = /^\d+$/.test(form.partMb.trim()) ? Number(form.partMb.trim()) * MB : 0;
  const maxPartBytes = part > 0 ? { maxPartBytes: part } : {};
  switch (form.kind) {
    case 'folder':
      return { ...base, settings: { path: form.path.trim() }, ...maxPartBytes };
    case 'ftp':
    case 'sftp': {
      const port = Number(form.port.trim()) || defaultPort(form.kind);
      const settings = {
        host: form.host.trim(),
        port,
        userName: form.userName.trim(),
        path: form.path.trim(),
        ...(form.kind === 'ftp' ? { tls: form.tls } : {}),
        ...(form.pinned ? { hostKeySha256: form.pinned } : {}),
      };
      const secret =
        form.kind === 'sftp' && form.auth === 'key'
          ? form.privateKey
            ? {
                privateKey: form.privateKey,
                ...(form.passphrase ? { privateKeyPassphrase: form.passphrase } : {}),
              }
            : null
          : form.password
            ? { password: form.password }
            : null;
      return { ...base, settings, ...(secret ? { secret } : {}), ...maxPartBytes };
    }
    default:
      return { ...base, settings: {}, ...maxPartBytes };
  }
}

export function DestinationDialog({
  server,
  destination,
  open,
  stepUp,
  onOpenChange,
  onSaved,
}: {
  server: DeployServer;
  destination: BackupDestinationInfo | null;
  open: boolean;
  stepUp: StepUp;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [form, setForm] = useState<Form>(() => formOf(destination));
  const [busy, setBusy] = useState<'test' | 'save' | 'signIn' | 'telegram' | null>(null);
  const [tested, setTested] = useState<BackupDestinationTest | null>(null);
  const [offeredKey, setOfferedKey] = useState<string | null>(null);
  const [telegram, setTelegram] = useState<TelegramLoginState | null>(null);
  const [code, setCode] = useState('');
  const [cloudPassword, setCloudPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(formOf(destination));
    setTested(null);
    setOfferedKey(null);
    setTelegram(null);
    setCode('');
    setCloudPassword('');
    setProblem(null);
  }, [open, destination]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const kind = form.kind;
  const cloud = kind === 'googleDrive' || kind === 'oneDrive';
  const named = form.name.trim().length > 0;
  const fieldsReady =
    kind === 'folder'
      ? form.path.trim().length > 0
      : kind === 'ftp' || kind === 'sftp'
        ? form.host.trim().length > 0 && form.userName.trim().length > 0
        : false;
  const sftpNeedsKey = kind === 'sftp' && !form.pinned;
  const canSave =
    busy === null &&
    named &&
    (kind === 'telegram' ? telegram?.step === 'done' : fieldsReady && !sftpNeedsKey && !offeredKey);

  async function test(): Promise<void> {
    setBusy('test');
    setProblem(null);
    setTested(null);
    try {
      const result = await window.agentmat.deployServerBackups.testDestination({
        serverId: server.id,
        destination: requestOf(form, destination?.id),
      });
      setTested(result);
      if (result.hostKeySha256 && result.hostKeySha256 !== form.pinned) {
        setOfferedKey(result.hostKeySha256);
      }
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function save(request: SaveBackupDestinationRequest): Promise<void> {
    setBusy('save');
    setProblem(null);
    try {
      const saved = await stepUp.run(() =>
        window.agentmat.deployServerBackups.saveDestination({
          serverId: server.id,
          destination: request,
        }),
      );
      if (!saved) return;
      toast.success(`${saved.name} is saved.`);
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  function saveForm(): void {
    if (!canSave) return;
    if (kind === 'telegram' && telegram?.step === 'done') {
      void save({
        ...(destination ? { id: destination.id } : {}),
        name: form.name.trim(),
        kind: 'telegram',
        settings: {
          apiId: Number(form.apiId),
          ...(telegram.accountName ? { accountName: telegram.accountName } : {}),
          isPremium: telegram.isPremium ?? false,
          chat: 'me',
        },
        secret: { apiHash: form.apiHash.trim(), telegramLoginId: telegram.loginId },
      });
      return;
    }
    void save(requestOf(form, destination?.id));
  }

  async function signIn(): Promise<void> {
    if (!cloud) return;
    setBusy('signIn');
    setProblem(null);
    try {
      const saved = await stepUp.run(() =>
        window.agentmat.deployServerBackups.connectCloudDrive({
          serverId: server.id,
          ...(destination ? { destinationId: destination.id } : {}),
          name: form.name.trim(),
          kind,
          clientId: form.clientId.trim(),
          ...(kind === 'googleDrive' && form.clientSecret.trim()
            ? { clientSecret: form.clientSecret.trim() }
            : {}),
          folderName: form.folderName.trim() || DEFAULT_FOLDER,
          ...(/^\d+$/.test(form.partMb.trim()) && Number(form.partMb) > 0
            ? { maxPartBytes: Number(form.partMb) * MB }
            : {}),
        }),
      );
      if (!saved) return;
      toast.success(`${saved.name} is signed in and saved.`);
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function telegramStep(): Promise<void> {
    setBusy('telegram');
    setProblem(null);
    try {
      const state = await stepUp.run(() =>
        telegram
          ? window.agentmat.deployServerBackups.continueTelegramLogin({
              serverId: server.id,
              loginId: telegram.loginId,
              ...(telegram.step === 'code' ? { code: code.trim() } : { password: cloudPassword }),
            })
          : window.agentmat.deployServerBackups.startTelegramLogin({
              serverId: server.id,
              apiId: Number(form.apiId),
              apiHash: form.apiHash.trim(),
              phoneNumber: form.phone.trim(),
            }),
      );
      if (!state) return;
      setTelegram(state);
      if (state.problem) setProblem(state.problem);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const id = (name: string) => `destination-${name}-${server.id}`;
  const field = (
    name: keyof Form,
    label: string,
    extra: Partial<React.ComponentProps<typeof Input>> = {},
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id(name)}>{label}</Label>
      <Input
        id={id(name)}
        value={String(form[name])}
        onChange={(event) => set(name, event.target.value as never)}
        autoComplete="off"
        {...extra}
      />
    </div>
  );
  const keepHint = destination?.hasSecret ? 'Leave empty to keep the saved one' : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => busy === null && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudUpload className="h-4 w-4 text-primary" />
            {destination ? `Edit ${destination.name}` : 'Add a destination'}
          </DialogTitle>
          <DialogDescription>
            The server sends its backups here, already encrypted. What you type for signing in goes
            to the server, sealed, and is never shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {field('name', 'Name', { placeholder: 'Storage box', autoFocus: true })}
            <div className="space-y-1.5">
              <Label htmlFor={id('kind')}>Kind</Label>
              <Combobox
                id={id('kind')}
                ariaLabel="Kind"
                options={KINDS}
                value={kind}
                disabled={destination !== null}
                onChange={(value) => {
                  if (!value) return;
                  set('kind', value as BackupDestinationKind);
                  setTested(null);
                  setOfferedKey(null);
                  setTelegram(null);
                }}
                searchable={false}
              />
            </div>
          </div>

          {kind === 'folder' &&
            field('path', 'Folder', {
              placeholder: '/var/backups/agentmate',
              className: 'font-mono',
            })}

          {(kind === 'ftp' || kind === 'sftp') && (
            <>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
                {field('host', 'Host', { placeholder: 'box.example.com' })}
                {field('port', 'Port', {
                  placeholder: String(defaultPort(kind)),
                  inputMode: 'numeric',
                })}
              </div>
              {field('userName', 'User')}
              {kind === 'sftp' && (
                <div className="space-y-1.5">
                  <Label htmlFor={id('auth')}>Sign in with</Label>
                  <Combobox
                    id={id('auth')}
                    ariaLabel="Sign in with"
                    options={[
                      { value: 'password', label: 'A password' },
                      { value: 'key', label: 'A private key' },
                    ]}
                    value={form.auth}
                    onChange={(value) => value && set('auth', value as Form['auth'])}
                    searchable={false}
                  />
                </div>
              )}
              {kind === 'sftp' && form.auth === 'key' ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor={id('key')}>Private key</Label>
                    <Textarea
                      id={id('key')}
                      value={form.privateKey}
                      onChange={(event) => set('privateKey', event.target.value)}
                      placeholder={keepHint ?? '-----BEGIN OPENSSH PRIVATE KEY-----'}
                      className="h-24 font-mono text-xs"
                      spellCheck={false}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={id('passphrase')}>Key passphrase (optional)</Label>
                    <SecretInput
                      id={id('passphrase')}
                      value={form.passphrase}
                      onChange={(value) => set('passphrase', value)}
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor={id('password')}>Password</Label>
                  <SecretInput
                    id={id('password')}
                    value={form.password}
                    onChange={(value) => set('password', value)}
                    placeholder={keepHint}
                  />
                </div>
              )}
              {field('path', 'Folder', { placeholder: '/backups', className: 'font-mono' })}
              {kind === 'ftp' && (
                <div className="flex items-center gap-2">
                  <Switch
                    id={id('tls')}
                    checked={form.tls}
                    onCheckedChange={(value) => set('tls', value)}
                  />
                  <Label htmlFor={id('tls')} className="font-normal">
                    Use FTPS (TLS)
                  </Label>
                </div>
              )}
              {kind === 'sftp' && !form.pinned && !offeredKey && (
                <p className="text-xs text-muted-foreground">
                  Test first. The server shows its host key, and nothing is saved until you trust
                  it.
                </p>
              )}
              {form.pinned && !offeredKey && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" /> Trusted key{' '}
                  <span className="break-all font-mono">{form.pinned}</span>
                </p>
              )}
            </>
          )}

          {offeredKey && (
            <div className="space-y-2" role="group" aria-label="Host key">
              <Notice tone="warning" icon={TriangleAlert} className="text-xs">
                {kind === 'sftp'
                  ? 'The server showed this host key. Check it with whoever runs that server before you trust it; a different key later means something is in the way.'
                  : 'The server showed a certificate that could not be checked. Trust it only if this is its fingerprint.'}
              </Notice>
              <p className={CODE_WELL}>{offeredKey}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    set('pinned', offeredKey);
                    setOfferedKey(null);
                  }}
                >
                  Trust this key
                </Button>
                <Button size="sm" variant="soft" onClick={() => setOfferedKey(null)}>
                  Do not trust it
                </Button>
              </div>
            </div>
          )}

          {cloud && (
            <>
              <Notice tone="neutral" className="text-xs">
                {kind === 'googleDrive' ? (
                  <>
                    Use your own OAuth client: in the Google Cloud console, turn on the Google Drive
                    API, then under Credentials create an OAuth client ID of type Desktop app and
                    copy its client ID and client secret here. The server only sees files it made
                    itself.
                  </>
                ) : (
                  <>
                    Use your own app: in the Microsoft Entra admin center, register an app for
                    personal and work accounts, add the platform Mobile and desktop applications
                    with the redirect http://127.0.0.1, and copy its application (client) ID here.
                    Backups go to the app's own folder in OneDrive.
                  </>
                )}
              </Notice>
              {field('clientId', 'Client ID', { className: 'font-mono' })}
              {kind === 'googleDrive' && (
                <div className="space-y-1.5">
                  <Label htmlFor={id('clientSecret')}>Client secret</Label>
                  <SecretInput
                    id={id('clientSecret')}
                    value={form.clientSecret}
                    onChange={(value) => set('clientSecret', value)}
                  />
                </div>
              )}
              {field('folderName', 'Folder name')}
              {busy === 'signIn' && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                  <Spinner className="h-3 w-3 motion-safe:animate-spin" />
                  Finish signing in in your browser. This waits up to 5 minutes.
                  <Button
                    size="sm"
                    variant="link"
                    className="h-auto p-0 text-xs"
                    onClick={() =>
                      void window.agentmat.deployServerBackups.cancelCloudSignIn(server.id)
                    }
                  >
                    Cancel the sign-in
                  </Button>
                </p>
              )}
            </>
          )}

          {kind === 'telegram' && (
            <TelegramFields
              form={form}
              set={set}
              state={telegram}
              code={code}
              setCode={setCode}
              cloudPassword={cloudPassword}
              setCloudPassword={setCloudPassword}
              busy={busy === 'telegram'}
              onNext={() => void telegramStep()}
              id={id}
            />
          )}

          {kind !== 'telegram' &&
            field('partMb', 'Part size in MB (optional)', {
              inputMode: 'numeric',
              placeholder: 'One file',
            })}

          {tested && (
            <p
              role="status"
              className={tested.ok ? 'text-xs text-success' : 'text-xs text-destructive'}
            >
              {tested.ok
                ? 'It works. The server wrote a test file there, read it back and deleted it.'
                : (tested.problem ?? 'The test failed.')}
            </p>
          )}
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="soft"
            disabled={busy !== null && busy !== 'signIn'}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {cloud ? (
            <Button
              disabled={busy !== null || !named || form.clientId.trim().length === 0}
              onClick={() => void signIn()}
            >
              {busy === 'signIn' && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              {kind === 'googleDrive' ? 'Sign in with Google' : 'Sign in with Microsoft'}
            </Button>
          ) : (
            <>
              {kind !== 'telegram' && (
                <Button
                  variant="soft"
                  disabled={busy !== null || !fieldsReady}
                  onClick={() => void test()}
                >
                  {busy === 'test' && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
                  Test
                </Button>
              )}
              <Button disabled={!canSave} onClick={saveForm}>
                {busy === 'save' && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
                Save
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TelegramFields({
  form,
  set,
  state,
  code,
  setCode,
  cloudPassword,
  setCloudPassword,
  busy,
  onNext,
  id,
}: {
  form: Form;
  set: <K extends keyof Form>(key: K, value: Form[K]) => void;
  state: TelegramLoginState | null;
  code: string;
  setCode: (value: string) => void;
  cloudPassword: string;
  setCloudPassword: (value: string) => void;
  busy: boolean;
  onNext: () => void;
  id: (name: string) => string;
}): React.JSX.Element {
  const detailsReady =
    /^\d+$/.test(form.apiId.trim()) &&
    /^[0-9a-f]{32}$/i.test(form.apiHash.trim()) &&
    form.phone.trim().length >= 5;
  const spinner = busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />;

  return (
    <div className="space-y-3">
      <Notice tone="neutral" className="text-xs">
        Backups go to your own account's Saved Messages. Get an api_id and api_hash for your account
        at my.telegram.org, under API development tools.{' '}
        {telegramPartNote(state?.isPremium ?? false)}
      </Notice>
      {state === null && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={id('apiId')}>api_id</Label>
              <Input
                id={id('apiId')}
                value={form.apiId}
                onChange={(event) => set('apiId', event.target.value)}
                inputMode="numeric"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id('apiHash')}>api_hash</Label>
              <SecretInput
                id={id('apiHash')}
                value={form.apiHash}
                onChange={(value) => set('apiHash', value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id('phone')}>Phone number</Label>
            <Input
              id={id('phone')}
              value={form.phone}
              onChange={(event) => set('phone', event.target.value)}
              placeholder="+49 151 2345678"
              inputMode="tel"
            />
          </div>
          <Button size="sm" disabled={busy || !detailsReady} onClick={onNext}>
            {spinner}
            <Send className="h-3.5 w-3.5" /> Send the code
          </Button>
        </>
      )}
      {state?.step === 'code' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={id('code')}>Code from Telegram</Label>
            <Input
              id={id('code')}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="max-w-40 font-mono tracking-widest"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Telegram sent it to your other sessions, or by text.
            </p>
          </div>
          <Button size="sm" disabled={busy || code.trim().length === 0} onClick={onNext}>
            {spinner}
            Continue
          </Button>
        </>
      )}
      {state?.step === 'password' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={id('cloudPassword')}>Cloud password</Label>
            <SecretInput
              id={id('cloudPassword')}
              value={cloudPassword}
              onChange={setCloudPassword}
              placeholder="Your two-step verification password"
            />
          </div>
          <Button size="sm" disabled={busy || cloudPassword.length === 0} onClick={onNext}>
            {spinner}
            Continue
          </Button>
        </>
      )}
      {state?.step === 'done' && (
        <p className="flex items-center gap-2 text-sm text-foreground" role="status">
          <CircleCheck className="h-4 w-4 text-success" /> Signed in as{' '}
          {state.accountName ?? 'your account'}
          {state.isPremium ? ' (Premium)' : ''}. Save to finish.
        </p>
      )}
    </div>
  );
}
