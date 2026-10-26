import {
  type AppSettings,
  DEFAULT_PROXY_BYPASS,
  type ProxySettings as ProxyConfig,
  type ProxyMode,
  type ProxyProtocol,
} from '@runova/core';
import type { ProxyTestResult } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type RefObject, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  CircleX,
  Eye,
  EyeOff,
  Globe,
  Monitor,
  NetworkIcon,
  Plug,
  Route,
  Spinner,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

const MODE_OPTIONS: {
  value: ProxyMode;
  label: string;
  hint: string;
  icon: typeof Globe;
}[] = [
  {
    value: 'direct',
    label: 'No proxy',
    hint: 'Requests go straight out, the way they always have.',
    icon: Globe,
  },
  {
    value: 'system',
    label: 'System proxy',
    hint: 'Follow whatever this machine is set to, PAC scripts included.',
    icon: Monitor,
  },
  {
    value: 'manual',
    label: 'Manual proxy',
    hint: 'Send everything through the server you type in below.',
    icon: Route,
  },
];

const PROTOCOL_OPTIONS: { value: ProxyProtocol; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks4', label: 'SOCKS4' },
];

function testMessage(result: ProxyTestResult): string {
  if (!result.ok) return result.error ?? 'The test request did not get through.';
  const where = result.country
    ? ` from ${result.ip ?? 'an unknown address'} (${result.country})`
    : '';
  const speed = result.latencyMs != null ? ` in ${result.latencyMs} ms` : '';
  return `Reached the internet${where}${speed}.`;
}

/**
 * Where Runova's outgoing requests go. One setting covers the whole app: the
 * AI providers, the skill and package registries, Telegram, update checks, and
 * the CLIs and git commands it spawns.
 *
 * Unlike the switches elsewhere in Settings, a half-typed host would take the
 * app offline the moment it was applied, so this card holds its changes until
 * they are saved.
 */
export function ProxySettings({
  settings,
  onDirtyChange,
  saveRef,
  resetToken,
}: {
  settings: AppSettings;
  onDirtyChange?: (dirty: boolean) => void;
  /** Lets the page's Save all / Ctrl+S reach this card without lifting its state. */
  saveRef?: RefObject<(() => Promise<void>) | null>;
  /** Changes when the page's Discard all is pressed. */
  resetToken?: number;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const saved = settings.proxy;

  const [draft, setDraft] = useState<ProxyConfig>(saved);
  const [dirty, setDirty] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  // Settings refetch on every save and on window focus, so the draft only
  // follows the stored copy while the user has nothing in flight.
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the token is the signal, the draft is not
  useEffect(() => {
    if (resetToken === undefined) return;
    setDraft(settings.proxy);
    setTestResult(null);
    setDirty(false);
    // The page tracks the card's dirty flag too, and keeps showing the save bar until told.
    onDirtyChange?.(false);
  }, [resetToken]);

  const statusQuery = useQuery({
    queryKey: queryKeys.proxyStatus,
    queryFn: () => window.runova.proxy.status(),
  });

  function patch(next: Partial<ProxyConfig>): void {
    setDraft((prev) => ({ ...prev, ...next }));
    setTestResult(null);
    setDirty(true);
    onDirtyChange?.(true);
  }

  function cleaned(): ProxyConfig {
    return {
      ...draft,
      host: draft.host.trim(),
      username: draft.username.trim(),
      bypassList: [...new Set(draft.bypassList.map((rule) => rule.trim()).filter(Boolean))],
    };
  }

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const next = cleaned();
      if (next.mode === 'manual' && !next.host) throw new Error('Enter the proxy host.');
      if (next.mode === 'manual' && next.port == null) {
        throw new Error('Enter the proxy port.');
      }
      await window.runova.settings.update({ proxy: next });
    },
    onSuccess: () => {
      setDirty(false);
      onDirtyChange?.(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.proxyStatus });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ipGeo });
      toast.success('Proxy settings applied.');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  useEffect(() => {
    if (!saveRef) return;
    saveRef.current = dirty ? () => save.mutateAsync() : null;
    return () => {
      saveRef.current = null;
    };
  }, [saveRef, dirty, save]);

  function discard(): void {
    setDraft(saved);
    setTestResult(null);
    setDirty(false);
    onDirtyChange?.(false);
  }

  async function runTest(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await window.runova.proxy.test(cleaned()));
    } finally {
      setTesting(false);
    }
  }

  const manual = draft.mode === 'manual';
  const status = statusQuery.data;
  const canTest = !testing && (!manual || (draft.host.trim() !== '' && draft.port != null));

  return (
    <Card className={cn('glass', dirty && 'ring-1 ring-primary/35')}>
      <CardHeader className="flex-row items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <NetworkIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Proxy</CardTitle>
            {dirty ? (
              <Badge variant="warning" className="font-normal">
                Unsaved
              </Badge>
            ) : null}
          </div>
          <CardDescription>
            How Runova reaches the internet. Covers the AI providers, the skill and package
            registries, Telegram, update checks, and the CLIs and git commands it runs for you.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="space-y-3">
          <Label>Connection</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {MODE_OPTIONS.map((option) => {
              const active = draft.mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => patch({ mode: option.value })}
                  className={cn(
                    'flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-all duration-150',
                    active
                      ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/40'
                      : 'border-border bg-background/40 hover:border-foreground/20 hover:bg-accent/40',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <option.icon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">{option.label}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {option.hint}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {draft.mode === 'system' ? (
          <p className="rounded-lg border border-border bg-background/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {status?.systemServer
              ? `This machine is set to ${status.systemServer}.`
              : 'This machine has no proxy configured right now, so requests go straight out. Set one in your OS network settings and Runova picks it up.'}
          </p>
        ) : null}

        {manual ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[9rem_1fr_7rem]">
              <div className="space-y-1.5">
                <Label htmlFor="proxy-protocol">Protocol</Label>
                <Combobox
                  value={draft.protocol}
                  onChange={(value) => patch({ protocol: value as ProxyProtocol })}
                  options={PROTOCOL_OPTIONS}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proxy-host">Host</Label>
                <Input
                  id="proxy-host"
                  value={draft.host}
                  placeholder="127.0.0.1"
                  spellCheck={false}
                  onChange={(event) => patch({ host: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proxy-port">Port</Label>
                <Input
                  id="proxy-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port == null ? '' : String(draft.port)}
                  placeholder="8080"
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === '') {
                      patch({ port: null });
                      return;
                    }
                    const parsed = Number(raw);
                    if (Number.isInteger(parsed)) patch({ port: parsed });
                  }}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="proxy-username">Username</Label>
                <Input
                  id="proxy-username"
                  value={draft.username}
                  placeholder="Leave empty if the proxy needs no login"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => patch({ username: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proxy-password">Password</Label>
                <div className="relative">
                  <Input
                    id="proxy-password"
                    type={showPassword ? 'text' : 'password'}
                    value={draft.password}
                    autoComplete="off"
                    className="pr-9"
                    onChange={(event) => patch({ password: event.target.value })}
                  />
                  <SimpleTooltip label={showPassword ? 'Hide password' : 'Show password'}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-1 top-1/2 -translate-y-1/2"
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </Button>
                  </SimpleTooltip>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="proxy-bypass">Skip the proxy for</Label>
              <Input
                id="proxy-bypass"
                value={draft.bypassList.join(', ')}
                placeholder={DEFAULT_PROXY_BYPASS.join(', ')}
                spellCheck={false}
                onChange={(event) => patch({ bypassList: event.target.value.split(',') })}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Comma separated. <code>&lt;local&gt;</code> covers localhost and this machine, which
                is what keeps a local Ollama or LanguageTool server off the proxy. A whole domain
                works too, like <code>*.corp.example</code>.
              </p>
            </div>
          </div>
        ) : null}

        {testResult ? (
          <div
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed',
              testResult.ok
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : 'border-destructive/40 bg-destructive/10 text-destructive',
            )}
          >
            {testResult.ok ? (
              <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0">{testMessage(testResult)}</span>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
          <p className="text-xs text-muted-foreground">
            {status?.effectiveServer
              ? `Right now the app is going through ${status.effectiveServer}.`
              : 'Right now the app connects straight out.'}{' '}
            Terminals that are already open keep the old setting until they are reopened.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="soft" disabled={!canTest} onClick={() => void runTest()}>
              {testing ? (
                <Spinner className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plug className="h-3.5 w-3.5" />
              )}
              Test connection
            </Button>
            {dirty ? (
              <Button variant="soft" onClick={discard}>
                Discard
              </Button>
            ) : null}
            <Button
              disabled={!dirty || save.isPending}
              onClick={() => void save.mutateAsync().catch(() => undefined)}
            >
              {save.isPending ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
