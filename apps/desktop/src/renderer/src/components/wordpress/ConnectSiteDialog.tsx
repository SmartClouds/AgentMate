import {
  parseWpConnectionKey,
  type WpConnectionKeyError,
  wpKeyTransportSecurity,
} from '@runova/core';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { wordPressErrorCode } from '@shared/wordpressErrors';
import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { ConnectorSteps } from '@/components/deploy/wordpress/ConnectorDownloadCard';
import { useSaveConnectorZip } from '@/components/deploy/wordpress/hooks';
import { SCOPE_SUMMARY, siteHost, wpProblem } from '@/components/deploy/wordpress/messages';
import { PlainHttpNotice } from '@/components/deploy/wordpress/PlainHttpNotice';
import { CircleInfo, Download, Spinner, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
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
import { WordPressMark } from './WordPressMark';

/**
 * Connects a WordPress site with a key from the Runova Connector plugin (E20). Deploy and the
 * Projects flow both open it.
 *
 * The key is a one-time secret. It lives only in this component's state: it is read here to show
 * the site, scope and expiry before connecting, goes into one `connect` call, and is cleared on
 * success and whenever the dialog closes. It never goes through React Query (whose mutation cache
 * keeps a call's input), a store, a log or a toast. The HTTP sign-in password is treated the same.
 */
export interface ConnectSiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: (site: DeployWordPressSite) => void;
}

const KEY_HINTS: Record<WpConnectionKeyError, string> = {
  format:
    "This doesn't look like a connection key. Copy the whole key from Tools > Runova Connector in the site's admin; it starts with amwp1.",
  version:
    'This key is for a different version of the connector. Update the plugin on the site (or update Runova), then make a new key.',
  fields: "This key is incomplete or damaged. Copy it again from the site's admin.",
  url: "The addresses in this key aren't ones Runova can use. Check the site's address in Settings > General, then make a new key.",
  expired:
    'This key has expired. Keys work once, for 15 minutes. Make a new one in Tools > Runova Connector.',
};

function minutesLeft(expiresAtSeconds: number, now: number): string {
  const minutes = Math.floor((expiresAtSeconds * 1000 - now) / 60_000);
  if (minutes < 1) return 'Works for less than a minute more, so connect now.';
  return `Works for ${minutes} more ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/** A message that somehow carries the key (or its secret) is replaced, never shown. */
function withoutSecrets(message: string, secrets: string[]): string {
  return secrets.some((secret) => secret.length >= 16 && message.includes(secret))
    ? 'The site refused the connection.'
    : message;
}

export function ConnectSiteDialog({
  open,
  onOpenChange,
  onConnected,
}: ConnectSiteDialogProps): React.JSX.Element {
  const id = useId();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [allowPlainHttp, setAllowPlainHttp] = useState(false);
  const [useHttpAuth, setUseHttpAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { save, saving } = useSaveConnectorZip();

  const reset = useCallback(() => {
    setKey('');
    setLabel('');
    setAllowPlainHttp(false);
    setUseHttpAuth(false);
    setUsername('');
    setPassword('');
    setProblem(null);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return undefined;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [open, reset]);

  const compact = key.replace(/\s+/g, '');
  const parsed = compact ? parseWpConnectionKey(compact, Math.floor(now / 1000)) : null;
  const parsedKey = parsed?.ok ? parsed.key : null;
  const transport = parsedKey ? wpKeyTransportSecurity(parsedKey) : null;
  const needsPlainOptIn = transport === 'plain-http';
  const canConnect =
    parsedKey !== null &&
    !busy &&
    (!needsPlainOptIn || allowPlainHttp) &&
    (!useHttpAuth || (username.trim() !== '' && password !== ''));

  function close(next: boolean): void {
    if (!next) reset();
    onOpenChange(next);
  }

  async function connect(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canConnect || !parsedKey) return;
    setBusy(true);
    setProblem(null);
    try {
      const site = await window.runova.deployWordPress.connect({
        connectionKey: compact,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(needsPlainOptIn && allowPlainHttp ? { allowPlainHttp: true } : {}),
        ...(useHttpAuth ? { httpAuth: { username: username.trim(), password } } : {}),
      });
      reset();
      toast.success(`Connected ${site?.label ?? 'the site'}.`);
      if (site) onConnected?.(site);
      onOpenChange(false);
    } catch (error) {
      if (wordPressErrorCode(error) === 'httpAuthRequired') setUseHttpAuth(true);
      setProblem(withoutSecrets(wpProblem(error, 'connect'), [compact, parsedKey.pairingSecret]));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WordPressMark className="h-5 w-5" /> Connect a WordPress site
          </DialogTitle>
          <DialogDescription>
            Paste the connection key from Tools &gt; Runova Connector in the site's admin. A key
            works once, for 15 minutes.
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="-mx-1 space-y-4 overflow-y-auto px-1"
          onSubmit={(event) => void connect(event)}
        >
          <div className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-2.5 text-sm">
            <p className="text-muted-foreground">
              Don't have the connector on the site yet?{' '}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? (
                  <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Download the plugin
              </Button>
            </p>
            <details className="mt-1.5">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                How to install it and make a key
              </summary>
              <ConnectorSteps className="mt-2 text-xs" />
            </details>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-key`}>Connection key</Label>
            <Textarea
              id={`${id}-key`}
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setProblem(null);
              }}
              placeholder="amwp1..."
              rows={4}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              className="break-all font-mono text-xs"
            />
            {parsed && !parsed.ok && (
              <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                {KEY_HINTS[parsed.error]}
              </p>
            )}
          </div>

          {parsedKey && (
            <dl
              aria-label="What this key connects"
              className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border/70 px-3 py-2.5 text-sm"
            >
              <dt className="text-xs text-muted-foreground">Site</dt>
              <dd className="break-all font-mono text-xs text-foreground">{parsedKey.siteUrl}</dd>
              <dt className="text-xs text-muted-foreground">Access</dt>
              <dd className="text-foreground">{SCOPE_SUMMARY[parsedKey.scope]}</dd>
              <dt className="text-xs text-muted-foreground">Key</dt>
              <dd className="text-foreground">{minutesLeft(parsedKey.expiresAt, now)}</dd>
            </dl>
          )}

          {needsPlainOptIn && (
            <PlainHttpNotice>
              <div className="flex items-center gap-3 pl-6">
                <Switch
                  id={`${id}-plain`}
                  checked={allowPlainHttp}
                  onCheckedChange={setAllowPlainHttp}
                />
                <Label htmlFor={`${id}-plain`} className="cursor-pointer">
                  Allow plain HTTP for this site
                </Label>
              </div>
            </PlainHttpNotice>
          )}
          {transport === 'local-http' && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <CircleInfo className="mt-0.5 h-3 w-3 shrink-0" />
              Plain HTTP to this computer is fine for local development; nothing leaves the machine.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-label`}>Name in Runova (optional)</Label>
            <Input
              id={`${id}-label`}
              value={label}
              maxLength={100}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={parsedKey ? (parsedKey.label ?? siteHost(parsedKey.siteUrl)) : 'My site'}
              autoComplete="off"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Switch id={`${id}-auth`} checked={useHttpAuth} onCheckedChange={setUseHttpAuth} />
              <Label htmlFor={`${id}-auth`} className="cursor-pointer">
                The site asks for an HTTP sign-in
              </Label>
            </div>
            {useHttpAuth && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-user`}>User name</Label>
                  <Input
                    id={`${id}-user`}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-password`}>Password</Label>
                  <SecretInput id={`${id}-password`} value={password} onChange={setPassword} />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  For staging sites behind a browser sign-in box. It's sealed on this computer and
                  never shown again.
                </p>
              </div>
            )}
          </div>

          {problem && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-foreground"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span>{problem}</span>
            </div>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={!canConnect}>
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
