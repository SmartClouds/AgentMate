import {
  checkEnvironment,
  checkServerName,
  dsnDestination,
  ERROR_REPORTING_LEVELS,
  type ErrorReportingLevel,
  MAX_ENVIRONMENT_LENGTH,
  MAX_SERVER_NAME_LENGTH,
  parseSentryDsn,
} from '@shared/deploy/errorReportingValidation';
import type { DeployErrorReportingStatus } from '@shared/deployErrorReportingTypes';
import { useId, useState } from 'react';
import { Lock, Spinner, Trash2 } from '@/components/icons';
import { Notice, PillTabs } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Switch } from '@/components/ui/switch';

/** What the form hands over: the DSN only when one was pasted, so an empty field keeps the stored one. */
export interface ErrorReportingValues {
  dsn?: string;
  enabled: boolean;
  environment: string;
  serverName: string;
  level: ErrorReportingLevel;
}

const ENVIRONMENT_SUGGESTIONS = ['production', 'staging', 'development'] as const;

/**
 * Where to send, under which names, and from which level up. Checked as the user types with the
 * same rules the main process and the core apply again. The DSN field is write-only: it starts
 * empty even when one is stored, and the core never says what it holds.
 */
export function ErrorReportingForm({
  status,
  busy,
  problems,
  onSubmit,
  onRemove,
}: {
  status: DeployErrorReportingStatus;
  busy: 'save' | 'remove' | null;
  /** What the core refused, to show above the buttons. */
  problems: string[];
  /** Resolves true when the setup was saved, so the key can leave the form. */
  onSubmit: (values: ErrorReportingValues) => Promise<boolean>;
  onRemove: () => void;
}): React.JSX.Element {
  const id = useId();
  const [dsn, setDsn] = useState('');
  const [environment, setEnvironment] = useState(status.environment);
  const [serverName, setServerName] = useState(status.configured ? status.serverName : '');
  const [level, setLevel] = useState<ErrorReportingLevel>(
    status.minLevel === 'error' ? 'error' : 'warning',
  );
  const [enabled, setEnabled] = useState(status.configured ? status.enabled : true);
  const [touched, setTouched] = useState(false);

  const dsnText = dsn.trim();
  const dsnCheck = parseSentryDsn(dsnText);
  const dsnOptional = status.configured && dsnText.length === 0;
  const dsnProblem = dsnOptional || dsnCheck.ok ? null : dsnCheck.reason;
  const environmentCheck = checkEnvironment(environment);
  const serverNameCheck = checkServerName(serverName);
  const valid = dsnProblem === null && environmentCheck.ok && serverNameCheck.ok;
  const saving = busy === 'save';

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (!valid || !environmentCheck.ok || !serverNameCheck.ok) return;
    const saved = await onSubmit({
      ...(dsnText ? { dsn: dsnText } : {}),
      enabled,
      environment: environmentCheck.value,
      serverName: serverNameCheck.value,
      level,
    });
    if (saved) setDsn('');
  }

  return (
    <form
      className="space-y-4"
      aria-label="Error reporting settings"
      onSubmit={(event) => void submit(event)}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-dsn`}>Sentry DSN</Label>
        <SecretInput
          id={`${id}-dsn`}
          value={dsn}
          onChange={setDsn}
          onBlur={() => setTouched(true)}
          placeholder={
            status.configured
              ? 'Leave empty to keep the current key'
              : 'https://key@o123.ingest.sentry.io/456'
          }
          aria-invalid={touched && dsnProblem !== null}
          aria-describedby={`${id}-dsn-hint`}
        />
        <p
          id={`${id}-dsn-hint`}
          className={
            touched && dsnProblem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
          }
        >
          {touched && dsnProblem
            ? dsnProblem
            : dsnCheck.ok
              ? `Sends to ${dsnDestination(dsnCheck.value)}`
              : 'It is sealed on the server and never shown again, here or anywhere else.'}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-environment`}>Environment</Label>
          <Input
            id={`${id}-environment`}
            value={environment}
            maxLength={MAX_ENVIRONMENT_LENGTH + 8}
            onChange={(event) => setEnvironment(event.target.value)}
            aria-invalid={touched && !environmentCheck.ok}
            aria-describedby={`${id}-environment-hint`}
          />
          <div className="flex flex-wrap items-center gap-1">
            {ENVIRONMENT_SUGGESTIONS.map((name) => (
              <Button
                key={name}
                type="button"
                size="xs"
                variant="soft"
                aria-pressed={environment.trim() === name}
                onClick={() => setEnvironment(name)}
              >
                {name}
              </Button>
            ))}
          </div>
          <p
            id={`${id}-environment-hint`}
            className={
              touched && !environmentCheck.ok
                ? 'text-xs text-destructive'
                : 'text-xs text-muted-foreground'
            }
          >
            {touched && !environmentCheck.ok
              ? environmentCheck.reason
              : 'Sentry lets you filter by it. Empty means production.'}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-server`}>Server name</Label>
          <Input
            id={`${id}-server`}
            value={serverName}
            placeholder={status.defaultServerName}
            maxLength={MAX_SERVER_NAME_LENGTH + 8}
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
              : 'Put on every event, so servers sharing a project can be told apart. Empty uses the machine name.'}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-sm font-medium leading-none">What to send</span>
        <div>
          <PillTabs
            id={`${id}-level`}
            label="What to send"
            kind="toggle"
            items={ERROR_REPORTING_LEVELS.map((item) => ({ value: item.value, label: item.label }))}
            value={level}
            onChange={setLevel}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {ERROR_REPORTING_LEVELS.find((item) => item.value === level)?.hint}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Switch id={`${id}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
        <Label htmlFor={`${id}-enabled`} className="cursor-pointer">
          Send logs to Sentry
        </Label>
        <span className="text-xs text-muted-foreground">
          {enabled ? 'On' : 'Paused: the setup is kept, nothing is sent.'}
        </span>
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
          {status.configured ? 'Save changes' : 'Turn on error reporting'}
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
