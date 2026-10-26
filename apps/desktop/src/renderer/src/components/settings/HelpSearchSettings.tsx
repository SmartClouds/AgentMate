import { type AppSettings, HELP_EMBEDDING_MODELS, helpEmbeddingModel } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Search, StopCircle } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import type { AiProvider, HelpIndexProgress } from '../../../../shared/apiTypes';

const PROVIDERS: Array<{ id: AiProvider; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'ollama', label: 'Ollama' },
];

/** Whether the provider can make embeddings at all: a key for the hosted ones, Ollama always. */
function providerSetUp(provider: AiProvider, settings: AppSettings): boolean {
  if (provider === 'openai') return !!settings.openaiApiKey?.trim();
  if (provider === 'gemini') return !!settings.geminiApiKey?.trim();
  return true;
}

export function helpStatusQueryKey(provider: AiProvider): readonly unknown[] {
  return ['help-index-status', provider];
}

/**
 * Settings > AI > Help search: which embedding model the Help guide searches the articles with,
 * per provider, and the state of the index for it. Picking a model saves it and rebuilds the
 * index with it straight away.
 */
export function HelpSearchSettings({ settings }: { settings: AppSettings }): React.JSX.Element {
  return (
    <Card className="glass">
      <CardHeader className="flex-row items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Search className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <CardTitle>Help search</CardTitle>
          <CardDescription>
            The embedding model the Help guide uses to find the right articles for a question, for
            each provider. A multilingual model helps when you ask in a language other than English.
            Changing the model indexes the help again with it.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="settings-rows -mx-1">
          {PROVIDERS.map((p) => (
            <ProviderRow key={p.id} provider={p.id} label={p.label} settings={settings} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderRow({
  provider,
  label,
  settings,
}: {
  provider: AiProvider;
  label: string;
  settings: AppSettings;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const ready = providerSetUp(provider, settings);
  const model = helpEmbeddingModel(provider, settings.helpEmbeddingModels);
  const embedderId = `${provider}:${model}`;
  const [progress, setProgress] = useState<HelpIndexProgress | null>(null);

  const statusQuery = useQuery({
    queryKey: helpStatusQueryKey(provider),
    queryFn: () => window.runova.help.status(provider),
    enabled: ready,
  });
  const modelsQuery = useQuery({
    queryKey: ['help-embedding-models', provider, settings.ollamaBaseUrl],
    queryFn: () => window.runova.help.embeddingModels(provider),
    enabled: ready,
    staleTime: 60_000,
  });

  useEffect(
    () =>
      window.runova.help.onIndexProgress((p) => {
        if (p.embedder === embedderId) setProgress(p);
      }),
    [embedderId],
  );

  // Both writes show their state in the row (progress bar, Stop, a disabled picker), so they opt
  // out of the full-page loading overlay, which would otherwise cover Settings for minutes.
  const reindex = useMutation({
    meta: { silentLoading: true },
    mutationFn: (fresh: boolean) => window.runova.help.reindex(provider, { fresh }),
    onMutate: () => setProgress(null),
    onSettled: () => {
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: helpStatusQueryKey(provider) });
    },
    onSuccess: (result) => {
      if (result.cancelled) return;
      if (result.ok)
        toast.success(`${label} help search is up to date (${result.embedded} passages).`);
      else toast.error(result.error ?? 'Indexing the help failed.');
    },
  });

  const saveModel = useMutation({
    meta: { silentLoading: true },
    mutationFn: (next: string) =>
      window.runova.settings.update({
        helpEmbeddingModels: { ...settings.helpEmbeddingModels, [provider]: next },
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(queryKeys.settings, saved);
      await queryClient.invalidateQueries({ queryKey: helpStatusQueryKey(provider) });
      reindex.mutate(false);
    },
    onError: (error) => toast.error((error as Error).message || 'Could not save the model.'),
  });

  const options = (modelsQuery.data ?? []).map((o) => ({
    value: o.value,
    label: provider === 'ollama' && o.installed === false ? `${o.label} (not installed)` : o.label,
  }));
  const optionList = options.some((o) => o.value === model)
    ? options
    : [{ value: model, label: model }, ...options];
  const picked = modelsQuery.data?.find((o) => o.value === model);
  const needsPull = provider === 'ollama' && modelsQuery.isSuccess && picked?.installed !== true;

  const status = statusQuery.data;
  const statusMatchesModel = status?.embedder === embedderId;
  const embedded = statusMatchesModel ? status.embedded : 0;
  const total = status?.chunks ?? 0;
  const running = reindex.isPending;
  const complete = total > 0 && embedded >= total;
  const shownDone = progress?.done ?? embedded;
  const shownTotal = progress?.total ?? total;
  const percent = shownTotal > 0 ? Math.round((shownDone / shownTotal) * 100) : 0;

  return (
    <div
      className={cn('flex flex-col gap-3 px-1 py-4 first:pt-0 last:pb-0', !ready && 'opacity-60')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {!ready ? (
            <Badge variant="secondary" className="font-normal">
              Add an API key above first
            </Badge>
          ) : complete && !running ? (
            <Badge variant="success" className="font-normal">
              Indexed
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Combobox
            className="w-72"
            ariaLabel={`${label} embedding model`}
            value={model}
            onChange={(next) => {
              if (next && next !== model) saveModel.mutate(next);
            }}
            options={optionList}
            allowCustom
            customLabel={(text) => `Use "${text}"`}
            placeholder={HELP_EMBEDDING_MODELS[provider].id}
            disabled={!ready || running || saveModel.isPending}
          />
          {running ? (
            <Button variant="soft" onClick={() => void window.runova.help.cancelReindex(provider)}>
              <StopCircle className="h-3.5 w-3.5" /> Stop
            </Button>
          ) : (
            <Button
              variant="soft"
              disabled={!ready || saveModel.isPending}
              onClick={() => reindex.mutate(complete)}
            >
              <RefreshCw className="h-3.5 w-3.5" /> {complete ? 'Rebuild index' : 'Update index'}
            </Button>
          )}
        </div>
      </div>

      {ready && (
        <div className="space-y-1.5">
          <div
            role="progressbar"
            aria-label={`${label} help index`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]"
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-300',
                complete && !running ? 'bg-emerald-500/70' : 'bg-primary',
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {running
              ? `Indexing with ${model}: ${shownDone} of ${shownTotal || '…'} passages`
              : total === 0
                ? 'The index is built the first time it is needed.'
                : `${embedded} of ${total} passages indexed with ${model}${status?.backend === 'sqlite-vec' ? ', searched with sqlite-vec' : ''}.`}
          </p>
          {needsPull && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              This model is not on your Ollama server yet. Run{' '}
              <code className="rounded bg-foreground/[0.07] px-1 font-mono">
                ollama pull {model}
              </code>
              , then click Update index.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
