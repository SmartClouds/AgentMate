import {
  type AppSettings,
  GRAMMAR_LANGUAGES,
  GRAMMAR_MOTHER_TONGUES,
  type GrammarSettings,
  LANGUAGETOOL_DEFAULT_PORT,
  LANGUAGETOOL_DOWNLOAD_URL,
} from '@runova/core';
import type { GrammarLocalStatus } from '@shared/grammar';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Ban,
  Download,
  FolderOpen,
  Globe,
  HardDrive,
  Play,
  RefreshCw,
  SpellCheck,
  Spinner,
  StopCircle,
  X,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

const MOTHER_TONGUE_OPTIONS = [
  { value: '', label: 'None' },
  ...GRAMMAR_MOTHER_TONGUES.map((entry) => ({ value: entry.value, label: entry.label })),
];

const SOURCE_OPTIONS: {
  value: GrammarSettings['source'];
  label: string;
  hint: string;
  icon: typeof Globe;
}[] = [
  {
    value: 'online',
    label: 'LanguageTool online',
    hint: 'No setup. Text is sent to api.languagetool.org.',
    icon: Globe,
  },
  {
    value: 'local',
    label: 'Local server',
    hint: 'Offline and unlimited. Needs the LanguageTool download and Java.',
    icon: HardDrive,
  },
];

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <div className={cn('flex items-start justify-between gap-4', disabled && 'opacity-50')}>
      <div className="min-w-0 space-y-0.5">
        <Label className="text-sm">{label}</Label>
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function serverBadge(status: GrammarLocalStatus | undefined): React.JSX.Element {
  if (!status) return <Badge variant="secondary">Checking…</Badge>;
  if (status.serverState === 'running') return <Badge variant="success">Server running</Badge>;
  if (status.serverState === 'starting') return <Badge variant="warning">Starting…</Badge>;
  if (status.serverState === 'error') return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="secondary">Stopped</Badge>;
}

/**
 * Writing check settings: what gets flagged, in which language, and whether
 * LanguageTool runs in the cloud or out of the app's own tools folder.
 *
 * Changes save as they are made, like the companion's settings, because most of
 * them are switches whose effect is immediate in every open text box.
 */
export function WritingCheckSettings({ settings }: { settings: AppSettings }): React.JSX.Element {
  const queryClient = useQueryClient();
  const grammar = settings.grammar;

  const save = useMutation({
    mutationFn: (patch: Partial<GrammarSettings>) =>
      window.runova.settings.update({ grammar: { ...grammar, ...patch } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  const statusQuery = useQuery({
    queryKey: queryKeys.grammarLocalStatus,
    queryFn: () => window.runova.grammar.localStatus(),
    // Cheap (a port probe and a directory read), and the folder can change under
    // us while this page is open.
    refetchInterval: 15_000,
  });
  const status = statusQuery.data;

  useEffect(() => {
    return window.runova.grammar.onLocalStatus((next) => {
      queryClient.setQueryData(queryKeys.grammarLocalStatus, next);
    });
  }, [queryClient]);

  const [port, setPort] = useState(String(grammar.localPort));
  useEffect(() => {
    setPort(String(grammar.localPort));
  }, [grammar.localPort]);

  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);

  async function runServerAction(action: 'start' | 'stop'): Promise<void> {
    setBusy(action);
    try {
      const next =
        action === 'start'
          ? await window.runova.grammar.startLocal()
          : await window.runova.grammar.stopLocal();
      queryClient.setQueryData(queryKeys.grammarLocalStatus, next);
      if (action === 'start' && next.serverState !== 'running') {
        toast.error(next.error ?? 'LanguageTool did not start.');
      }
    } finally {
      setBusy(null);
    }
  }

  function commitPort(): void {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      setPort(String(grammar.localPort));
      toast.error('Pick a port between 1024 and 65535.');
      return;
    }
    if (parsed !== grammar.localPort) save.mutate({ localPort: parsed });
  }

  const installed = Boolean(status?.installPath);
  const javaMissing = status !== undefined && status.javaVersion === null;
  // LanguageTool 6 is compiled for Java 17; an older JVM can't load it at all.
  const javaTooOld = status?.javaMajor != null && status.javaMajor < 17;

  return (
    <Card className="glass">
      <CardHeader className="flex-row items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <SpellCheck className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <CardTitle>Writing check</CardTitle>
          <CardDescription>
            Grammar, spelling, and style checks in every text box, powered by LanguageTool.
            Right-click a word for its fix, or open the counter for the whole list.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-4">
          <ToggleRow
            label="Check my writing"
            hint="Off means nothing is checked and no text leaves this machine."
            checked={grammar.enabled}
            onChange={(next) => save.mutate({ enabled: next })}
          />
          <ToggleRow
            label="Underline as I type"
            hint="Checks a field shortly after you stop typing. Off leaves right-click checks only."
            checked={grammar.liveCheck}
            disabled={!grammar.enabled}
            onChange={(next) => save.mutate({ liveCheck: next })}
          />
          <ToggleRow
            label="Include style suggestions"
            hint="LanguageTool's picky level: wordiness, repetition, and typography on top of mistakes."
            checked={grammar.picky}
            disabled={!grammar.enabled}
            onChange={(next) => save.mutate({ picky: next })}
          />
        </div>

        <div className={cn('grid max-w-lg gap-3 sm:grid-cols-2', !grammar.enabled && 'opacity-50')}>
          <div className="space-y-1.5">
            <Label>Language</Label>
            <Combobox
              value={grammar.language}
              disabled={!grammar.enabled}
              onChange={(value) => save.mutate({ language: value })}
              options={GRAMMAR_LANGUAGES}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Auto-detect handles a field per field. LanguageTool has no Persian rules, so Persian
              text falls back to the built-in spellchecker.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Native language</Label>
            <Combobox
              value={grammar.motherTongue ?? ''}
              disabled={!grammar.enabled}
              onChange={(value) => save.mutate({ motherTongue: value || null })}
              options={MOTHER_TONGUE_OPTIONS}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Turns on false-friend rules for mistakes speakers of that language tend to make.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <Label>Where checks run</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SOURCE_OPTIONS.map((option) => {
              const active = grammar.source === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={!grammar.enabled}
                  aria-pressed={active}
                  onClick={() => save.mutate({ source: option.value })}
                  className={cn(
                    // A button centres its content, so flex-col keeps both titles on the same line.
                    'flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
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

        {grammar.source === 'local' ? (
          <div className="space-y-3 rounded-xl border border-border bg-background/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              {serverBadge(status)}
              <Badge variant={installed ? 'success' : 'secondary'}>
                {installed
                  ? `LanguageTool ${status?.version ?? 'found'}`
                  : 'LanguageTool not in tools folder'}
              </Badge>
              <Badge variant={javaMissing ? 'destructive' : javaTooOld ? 'warning' : 'secondary'}>
                {status?.javaVersion ?? (javaMissing ? 'Java not found' : 'Checking Java…')}
              </Badge>
            </div>

            {javaTooOld ? (
              <p className="text-xs leading-relaxed text-warning">
                LanguageTool 6 needs Java 17 or newer. Java {status?.javaMajor} won't run it, so
                either install a newer JDK or stay on the online check.
              </p>
            ) : null}

            {status?.error ? (
              <p className="text-xs leading-relaxed text-destructive">{status.error}</p>
            ) : null}

            <ol className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              <li>1. Download the LanguageTool desktop zip.</li>
              <li>
                2. Extract it into the tools folder below (a LanguageTool-x.y folder is fine).
              </li>
              <li>3. Start the server. Runova stops it when it quits.</li>
            </ol>

            <code className="block overflow-x-auto whitespace-pre rounded bg-muted px-2 py-1.5 font-mono text-xs">
              {status?.toolsDir ?? '…'}
            </code>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="soft"
                onClick={() => void window.runova.shell.openExternal(LANGUAGETOOL_DOWNLOAD_URL)}
              >
                <Download /> Download
              </Button>
              <Button variant="soft" onClick={() => void window.runova.grammar.openToolsFolder()}>
                <FolderOpen /> Open tools folder
              </Button>
              {status?.serverState === 'running' ? (
                <Button
                  variant="soft"
                  disabled={busy !== null}
                  onClick={() => void runServerAction('stop')}
                >
                  {busy === 'stop' ? <Spinner className="animate-spin" /> : <StopCircle />} Stop
                  server
                </Button>
              ) : (
                <SimpleTooltip
                  label={
                    installed
                      ? 'Starting takes a few seconds while the rules load'
                      : 'Nothing to start until LanguageTool is in the tools folder'
                  }
                >
                  <Button
                    disabled={busy !== null || !installed || javaMissing}
                    onClick={() => void runServerAction('start')}
                  >
                    {busy === 'start' ? <Spinner className="animate-spin" /> : <Play />} Start
                    server
                  </Button>
                </SimpleTooltip>
              )}
              <Button
                variant="soft"
                onClick={() => void statusQuery.refetch()}
                disabled={statusQuery.isFetching}
              >
                <RefreshCw className={cn(statusQuery.isFetching && 'animate-spin')} /> Re-check
              </Button>
            </div>

            <div className="flex items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="languagetool-port">Port</Label>
                <Input
                  id="languagetool-port"
                  className="w-28"
                  value={port}
                  inputMode="numeric"
                  spellCheck={false}
                  onChange={(event) => setPort(event.target.value)}
                  onBlur={commitPort}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitPort();
                  }}
                />
              </div>
              <p className="pb-2 text-xs text-muted-foreground">
                Default {LANGUAGETOOL_DEFAULT_PORT}. An already-running server on this port (Docker,
                say) is used as it is.
              </p>
            </div>
          </div>
        ) : null}

        {grammar.ignoredRules.length > 0 ? (
          <div className="space-y-2">
            <Label>Muted rules</Label>
            <div className="flex flex-wrap gap-1.5">
              {grammar.ignoredRules.map((rule) => (
                <button
                  key={rule}
                  type="button"
                  onClick={() =>
                    save.mutate({
                      ignoredRules: grammar.ignoredRules.filter((entry) => entry !== rule),
                    })
                  }
                  className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-0.5 font-mono text-xs text-muted-foreground hover:border-foreground/25 hover:text-foreground"
                >
                  <Ban className="h-3 w-3" />
                  {rule}
                  <X className="h-3 w-3" />
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Rules you told the writing menu to stop flagging. Click one to unmute it.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
