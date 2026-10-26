import type { AlertKind } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import {
  checkBotToken,
  checkChatId,
  checkTelegramServerName,
  MAX_TELEGRAM_SERVER_NAME_LENGTH,
  TELEGRAM_ALERT_KINDS,
} from '@shared/deploy/telegramValidation';
import type { DeployTelegramDetectResult, DeployTelegramStatus } from '@shared/deployTelegramTypes';
import { useId, useState } from 'react';
import { Lock, Search, Spinner, Trash2 } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Switch } from '@/components/ui/switch';

/** What the form hands over: the token only when one was pasted, so an empty field keeps the stored one. */
export interface TelegramValues {
  botToken?: string;
  enabled: boolean;
  chatId: string;
  serverName: string;
  kinds: AlertKind[];
  sendResolved: boolean;
}

const TOKEN_NEEDED = 'Paste the token BotFather gave you when you created the bot.';

/**
 * Which bot, which chat, the name every message starts with, and which alerts. Checked as the user
 * types with the same rules the main process and the core apply again. The token field is
 * write-only: it starts empty even when one is stored, and the core never says what it holds.
 */
export function TelegramForm({
  status,
  nickname,
  busy,
  problems,
  onSubmit,
  onRemove,
  onDetect,
}: {
  status: DeployTelegramStatus;
  /** The server's name in this app: what a new setup calls it in messages. */
  nickname: string;
  busy: 'save' | 'remove' | null;
  /** What the core refused, to show above the buttons. */
  problems: string[];
  /** Resolves true when the setup was saved, so the token can leave the form. */
  onSubmit: (values: TelegramValues) => Promise<boolean>;
  onRemove: () => void;
  onDetect: (botToken: string) => Promise<DeployTelegramDetectResult | null>;
}): React.JSX.Element {
  const id = useId();
  const [serverName, setServerName] = useState(status.configured ? status.serverName : nickname);
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState(status.chatId ?? '');
  const [kinds, setKinds] = useState<ReadonlySet<AlertKind>>(() => new Set(status.kinds));
  const [sendResolved, setSendResolved] = useState(status.sendResolved);
  const [enabled, setEnabled] = useState(status.configured ? status.enabled : true);
  const [touched, setTouched] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectProblem, setDetectProblem] = useState<string | null>(null);

  const tokenText = token.trim();
  const tokenCheck = checkBotToken(tokenText);
  const tokenProblem =
    tokenText.length === 0
      ? status.configured
        ? null
        : TOKEN_NEEDED
      : tokenCheck.ok
        ? null
        : tokenCheck.reason;
  const chatCheck = checkChatId(chatId);
  const serverNameCheck = checkTelegramServerName(serverName);
  const valid = tokenProblem === null && chatCheck.ok && serverNameCheck.ok;
  const saving = busy === 'save';

  function toggleKind(kind: AlertKind, on: boolean): void {
    setKinds((current) => {
      const next = new Set(current);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }

  async function detect(): Promise<void> {
    if (!tokenCheck.ok) return;
    setDetecting(true);
    setDetectProblem(null);
    try {
      const found = await onDetect(tokenCheck.value);
      if (found?.chatId) setChatId(found.chatId);
      else if (found)
        setDetectProblem(found.error ?? 'Telegram did not say which chat wrote last.');
    } finally {
      setDetecting(false);
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (!valid || !chatCheck.ok || !serverNameCheck.ok) return;
    const saved = await onSubmit({
      ...(tokenCheck.ok ? { botToken: tokenCheck.value } : {}),
      enabled,
      chatId: chatCheck.value,
      serverName: serverNameCheck.value,
      kinds: TELEGRAM_ALERT_KINDS.filter((kind) => kinds.has(kind.value)).map((kind) => kind.value),
      sendResolved,
    });
    if (saved) setToken('');
  }

  const chatHint = detectProblem
    ? detectProblem
    : touched && !chatCheck.ok
      ? chatCheck.reason
      : 'The person or group that gets the alerts. Send the bot a message, or add it to the group, then press Detect.';

  return (
    <form
      className="space-y-4"
      aria-label="Telegram settings"
      onSubmit={(event) => void submit(event)}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-server`}>Server name</Label>
        <Input
          id={`${id}-server`}
          value={serverName}
          placeholder={status.defaultServerName}
          maxLength={MAX_TELEGRAM_SERVER_NAME_LENGTH + 8}
          onChange={(event) => setServerName(event.target.value)}
          aria-invalid={touched && !serverNameCheck.ok}
          aria-describedby={`${id}-server-hint`}
        />
        <p
          id={`${id}-server-hint`}
          className={
            touched && !serverNameCheck.ok
              ? 'text-xs text-destructive'
              : 'text-xs text-muted-foreground'
          }
        >
          {touched && !serverNameCheck.ok
            ? serverNameCheck.reason
            : 'Starts every message, so you can tell your servers apart. Empty uses the machine name.'}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-token`}>Bot token</Label>
          <SecretInput
            id={`${id}-token`}
            value={token}
            onChange={(next) => {
              setToken(next);
              setDetectProblem(null);
            }}
            onBlur={() => tokenText.length > 0 && setTouched(true)}
            placeholder={
              status.configured ? 'Leave empty to keep the current token' : '123456789:AAH...'
            }
            aria-invalid={touched && tokenProblem !== null}
            aria-describedby={`${id}-token-hint`}
          />
          <p
            id={`${id}-token-hint`}
            className={
              touched && tokenProblem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
            }
          >
            {touched && tokenProblem
              ? tokenProblem
              : 'It is sealed on the server and never shown again, here or anywhere else.'}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-chat`}>Chat ID</Label>
          <div className="flex gap-2">
            <Input
              id={`${id}-chat`}
              value={chatId}
              placeholder="123456789 or -1001234567890"
              className="font-mono"
              onChange={(event) => {
                setChatId(event.target.value);
                setDetectProblem(null);
              }}
              aria-invalid={(touched && !chatCheck.ok) || detectProblem !== null}
              aria-describedby={`${id}-chat-hint`}
            />
            <Button
              type="button"
              size="sm"
              variant="soft"
              disabled={!tokenCheck.ok || detecting}
              onClick={() => void detect()}
            >
              {detecting ? (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Detect
            </Button>
          </div>
          <p
            id={`${id}-chat-hint`}
            className={
              detectProblem || (touched && !chatCheck.ok)
                ? 'text-xs text-destructive'
                : 'text-xs text-muted-foreground'
            }
          >
            {chatHint}
            {!detectProblem && status.configured && tokenText.length === 0
              ? ' Detect needs the token typed again.'
              : ''}
          </p>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium leading-none">Alerts to send</legend>
        <div className="grid gap-x-6 gap-y-2.5 pt-1 sm:grid-cols-2">
          {TELEGRAM_ALERT_KINDS.map((kind) => (
            <div key={kind.value} className="flex items-start gap-3">
              <Switch
                id={`${id}-kind-${kind.value}`}
                checked={kinds.has(kind.value)}
                onCheckedChange={(on) => toggleKind(kind.value, on)}
                aria-describedby={`${id}-kind-${kind.value}-hint`}
                className="mt-0.5"
              />
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor={`${id}-kind-${kind.value}`} className="cursor-pointer">
                  {kind.label}
                </Label>
                <p id={`${id}-kind-${kind.value}-hint`} className="text-xs text-muted-foreground">
                  {kind.hint}
                </p>
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <Switch id={`${id}-resolved`} checked={sendResolved} onCheckedChange={setSendResolved} />
          <Label htmlFor={`${id}-resolved`} className="cursor-pointer">
            Also tell me when a problem clears
          </Label>
        </div>
        <div className="flex items-center gap-3">
          <Switch id={`${id}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor={`${id}-enabled`} className="cursor-pointer">
            Send alerts to Telegram
          </Label>
          <span className="text-xs text-muted-foreground">
            {enabled ? 'On' : 'Paused: the setup is kept, nothing is sent.'}
          </span>
        </div>
      </div>

      {problems.length > 0 && (
        <Notice role="alert" tone="destructive" size="sm">
          <ul className="space-y-0.5">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy !== null || (touched && !valid)}>
          {saving ? (
            <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
          ) : (
            <Lock className="h-3.5 w-3.5" />
          )}
          {status.configured ? 'Save changes' : 'Turn on Telegram alerts'}
        </Button>
        {status.configured && (
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={busy !== null}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          Saving asks for your password again if you have not confirmed it in the last 10 minutes.
        </span>
      </div>
    </form>
  );
}
