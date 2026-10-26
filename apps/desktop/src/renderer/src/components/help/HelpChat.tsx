import type { AppSettings } from '@runova/core';
import { GEMINI_API_MODELS, OPENAI_API_MODELS } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MarkdownMessage } from '@/components/askAi/MarkdownMessage';
import {
  ArrowUp,
  CircleQuestion,
  FileText,
  Robot,
  SettingsIcon,
  Sparkles,
  StopCircle,
  Trash2,
  TriangleAlert,
  X,
} from '@/components/icons';
import {
  EmptyState,
  FOOTER_HAIRLINE,
  GLASS_PANEL,
  SEGMENT_TRACK,
  segmentClass,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useAskAiStore } from '@/stores/askAiStore';
import { type HelpMessage, useHelpStore } from '@/stores/helpStore';
import type { AiProvider, HelpIndexProgress, HelpSource } from '../../../../shared/apiTypes';

const PROVIDERS: Array<{ id: AiProvider; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'ollama', label: 'Ollama' },
];

const STARTERS = [
  'How do I add an AI provider?',
  'How do I split the workspace into panes?',
  'Where are my backups and how do I restore one?',
  'How do I install the server core on a new server?',
];

/** Whether Settings has what the provider needs before the guide can use it. */
export function providerReady(
  provider: AiProvider,
  settings: Partial<AppSettings> | undefined,
  ollamaModel: string,
): boolean {
  if (!settings) return false;
  if (provider === 'openai') return !!settings.openaiApiKey?.trim();
  if (provider === 'gemini') return !!settings.geminiApiKey?.trim();
  return !!(ollamaModel || settings.ollamaModel)?.trim();
}

function helpHref(source: Pick<HelpSource, 'slug' | 'anchor'>): string {
  return `/help/${source.slug}${source.anchor ? `#${source.anchor}` : ''}`;
}

/**
 * Turns the answer's [n] citations into links to the passage they point at, so they render as
 * small numbered pills. Numbers that are not one of the answer's sources are left as written.
 */
function linkCitations(text: string, sources: HelpSource[]): string {
  const byN = new Map(sources.map((s) => [s.n, s]));
  return text.replace(/\[(\d{1,2})\](?!\()/g, (whole, n: string) => {
    const source = byN.get(Number(n));
    return source ? `[${n}](${helpHref(source)})` : whole;
  });
}

function AnswerBody({ message }: { message: HelpMessage }): React.JSX.Element {
  const navigate = useNavigate();
  const sources = message.sources ?? [];
  const content = useMemo(
    () => linkCitations(message.content, sources),
    [message.content, sources],
  );

  return (
    <div
      className="help-answer"
      // Citations are links MarkdownMessage draws as outside links; keep them inside the app.
      onClickCapture={(event) => {
        const anchor = (event.target as HTMLElement).closest('a');
        const href = anchor?.getAttribute('href') ?? '';
        if (href.startsWith('/help/')) {
          event.preventDefault();
          event.stopPropagation();
          navigate(href);
        }
      }}
    >
      <MarkdownMessage content={content} />
    </div>
  );
}

/** MarkdownMessage draws links itself, so citation pills get their name and look from here. */
function useCitationLabels(
  ref: React.RefObject<HTMLElement | null>,
  messages: HelpMessage[],
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the new messages are what put fresh links in the list
  useEffect(() => {
    for (const anchor of ref.current?.querySelectorAll<HTMLAnchorElement>("a[href^='/help/']") ??
      []) {
      if (!/^\d+$/.test(anchor.textContent ?? '')) continue;
      anchor.classList.add('help-cite');
      anchor.removeAttribute('target');
      anchor.setAttribute('aria-label', `Source ${anchor.textContent ?? ''}`);
    }
  }, [messages]);
}

export interface HelpChatProps {
  onClose: () => void;
}

export function HelpChat({ onClose }: HelpChatProps): React.JSX.Element {
  const navigate = useNavigate();
  const messages = useHelpStore((s) => s.messages);
  const addMessage = useHelpStore((s) => s.addMessage);
  const clearMessages = useHelpStore((s) => s.clearMessages);
  const provider = useAskAiStore((s) => s.provider);
  const setProvider = useAskAiStore((s) => s.setProvider);
  const openaiModel = useAskAiStore((s) => s.openaiModel);
  const geminiModel = useAskAiStore((s) => s.geminiModel);
  const ollamaModel = useAskAiStore((s) => s.ollamaModel);
  const setOpenaiModel = useAskAiStore((s) => s.setOpenaiModel);
  const setGeminiModel = useAskAiStore((s) => s.setGeminiModel);
  const setOllamaModel = useAskAiStore((s) => s.setOllamaModel);

  const [draft, setDraft] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<HelpIndexProgress | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const settings = settingsQuery.data;

  // biome-ignore lint/correctness/useExhaustiveDependencies: seed each model once, when settings first arrive
  useEffect(() => {
    if (!settings) return;
    if (!openaiModel) setOpenaiModel(settings.openaiModel);
    if (!geminiModel) setGeminiModel(settings.geminiModel);
    if (!ollamaModel) setOllamaModel(settings.ollamaModel);
    // Open on a provider that is actually set up, rather than one that would only error.
    if (!providerReady(provider, settings, ollamaModel)) {
      const ready = PROVIDERS.find((p) => providerReady(p.id, settings, ollamaModel));
      if (ready) setProvider(ready.id);
    }
  }, [settings]);

  const ready = providerReady(provider, settings, ollamaModel);
  const model =
    (provider === 'openai' ? openaiModel : provider === 'gemini' ? geminiModel : ollamaModel) || '';

  const statusQuery = useQuery({
    queryKey: ['help-index-status', provider],
    queryFn: () => window.runova.help.status(provider),
    enabled: ready,
  });

  const ollamaModelsQuery = useQuery({
    queryKey: ['ollama-models'],
    queryFn: () => window.runova.ai.listOllamaModels(),
    enabled: ready && provider === 'ollama',
    retry: false,
  });

  useEffect(() => window.runova.help.onIndexProgress(setProgress), []);

  useCitationLabels(listRef, messages);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message or the typing dots scroll to the end
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, pendingId]);

  const modelOptions =
    provider === 'openai'
      ? [...OPENAI_API_MODELS]
      : provider === 'gemini'
        ? [...GEMINI_API_MODELS]
        : (ollamaModelsQuery.data ?? []).map((name) => ({ value: name, label: name }));
  const withCurrent =
    model && !modelOptions.some((o) => o.value === model)
      ? [{ value: model, label: model }, ...modelOptions]
      : modelOptions;
  const setModel =
    provider === 'openai'
      ? setOpenaiModel
      : provider === 'gemini'
        ? setGeminiModel
        : setOllamaModel;

  async function ask(question: string): Promise<void> {
    const text = question.trim();
    if (!text || pendingId || !ready) return;
    const history = messages
      .filter((m): m is HelpMessage & { role: 'user' | 'assistant' } => m.role !== 'error')
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));
    addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      provider,
      model,
      createdAt: new Date().toISOString(),
    });
    setDraft('');
    const requestId = crypto.randomUUID();
    setPendingId(requestId);
    try {
      const result = await window.runova.help.ask({
        provider,
        model,
        question: text,
        history,
        requestId,
      });
      if (result.cancelled) return;
      addMessage({
        id: crypto.randomUUID(),
        role: result.ok ? 'assistant' : 'error',
        content: result.ok
          ? result.text
          : (result.error ?? 'The guide could not answer. Try again.'),
        sources: result.sources,
        ...(result.notice ? { notice: result.notice } : {}),
        provider,
        model,
        createdAt: new Date().toISOString(),
      });
    } finally {
      setPendingId(null);
      setProgress(null);
      void statusQuery.refetch();
    }
  }

  function stop(): void {
    if (pendingId) void window.runova.help.cancel(pendingId);
  }

  const status = statusQuery.data;
  const indexing = pendingId && progress && progress.done < progress.total;

  return (
    <aside aria-label="Help guide" className={cn(GLASS_PANEL, 'help-chat h-full min-h-0')}>
      <header className="flex h-14 shrink-0 items-center gap-2.5 pl-3.5 pr-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary shadow-[0_0_24px_-10px_hsl(var(--primary)/0.8)]">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-tight">Ask the guide</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {ready
              ? status
                ? `Answers from ${status.chunks} help passages`
                : 'Answers only from these help articles'
              : 'Needs an AI provider from Settings'}
          </p>
        </div>
        {messages.length > 0 && (
          <SimpleTooltip label="Clear conversation">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear conversation"
              onClick={clearMessages}
            >
              <Trash2 />
            </Button>
          </SimpleTooltip>
        )}
        <SimpleTooltip label="Close the guide">
          <Button variant="ghost" size="icon-sm" aria-label="Close the guide" onClick={onClose}>
            <X />
          </Button>
        </SimpleTooltip>
      </header>

      {settingsQuery.isSuccess && !ready ? (
        <div className={cn(FOOTER_HAIRLINE, 'flex flex-1 items-center justify-center')}>
          <EmptyState
            icon={Robot}
            title="Connect an AI provider to ask questions"
            description={
              <>
                The guide answers in plain words using these help articles. Add an OpenAI or Gemini
                key, or pick an Ollama model, in{' '}
                <strong className="text-foreground">Settings</strong> &gt;{' '}
                <strong className="text-foreground">AI</strong>. Search works without one.
              </>
            }
            action={
              <Button size="sm" onClick={() => navigate('/settings?tab=ai')}>
                <SettingsIcon className="h-3.5 w-3.5" /> Set up a provider
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div
            ref={listRef}
            className={cn(FOOTER_HAIRLINE, 'rail-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4')}
          >
            {messages.length === 0 ? (
              <div className="flex h-full flex-col justify-end gap-3 pb-1">
                <p className="text-[13px] leading-6 text-muted-foreground">
                  Ask how to do something in Runova. The guide reads the help articles, answers in
                  your language, and links the sections it used.
                </p>
                <div className="flex flex-col items-start gap-1.5">
                  {STARTERS.map((s) => (
                    <Button
                      key={s}
                      variant="soft"
                      size="sm"
                      // A starter can run to two lines in a narrow dock, so the pill grows with it.
                      className="h-auto min-h-7 max-w-full justify-start whitespace-normal py-1.5 text-left leading-snug"
                      onClick={() => void ask(s)}
                    >
                      <CircleQuestion className="h-3 w-3 text-primary" />
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <ol className="flex flex-col gap-5">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className={cn('flex flex-col gap-1.5', m.role === 'user' && 'items-end')}
                  >
                    {m.role === 'user' ? (
                      <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-md bg-primary/12 px-3.5 py-2 text-[13px] text-foreground ring-1 ring-inset ring-primary/15">
                        {m.content}
                      </div>
                    ) : m.role === 'error' ? (
                      <div className="flex max-w-full items-start gap-2 rounded-2xl bg-destructive/[0.06] px-3 py-2 text-[13px] text-destructive ring-1 ring-inset ring-destructive/25">
                        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="whitespace-pre-wrap">{m.content}</span>
                      </div>
                    ) : (
                      <>
                        <AnswerBody message={m} />
                        {(m.sources?.length ?? 0) > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {m.sources!.map((s) => (
                              <Link
                                key={`${s.n}-${s.slug}-${s.anchor}`}
                                to={helpHref(s)}
                                className="group inline-flex max-w-full items-center gap-1.5 rounded-full bg-foreground/[0.05] py-0.5 pl-0.5 pr-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-primary/12 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <span className="help-cite-static">{s.n}</span>
                                <FileText className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">
                                  {s.articleTitle}
                                  {s.heading ? ` › ${s.heading}` : ''}
                                </span>
                              </Link>
                            ))}
                          </div>
                        )}
                        {m.notice && (
                          <p className="text-[11px] leading-4 text-muted-foreground/80">
                            {m.notice}
                          </p>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {pendingId && (
              <div
                className="mt-5 flex items-center gap-2 text-xs text-muted-foreground"
                aria-live="polite"
              >
                <span className="flex items-center gap-1 rounded-full bg-foreground/[0.06] px-3 py-2">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
                </span>
                {indexing
                  ? `Reading the help for the first time, ${progress.done} of ${progress.total} passages`
                  : 'Looking through the help…'}
              </div>
            )}
          </div>

          {/* The composer, the way Ask AI draws it: one rounded pill with the question on top and
              the provider, the model and Send along its bottom edge. */}
          <form
            className="shrink-0 p-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(draft);
            }}
          >
            <div className="search-pill flex flex-col gap-1 rounded-[22px] p-1.5 transition-colors">
              <textarea
                ref={inputRef}
                aria-label="Ask a question"
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void ask(draft);
                  }
                }}
                placeholder="How do I…"
                className="max-h-32 min-h-[38px] w-full resize-none bg-transparent px-2 py-1.5 text-[13px] outline-none [field-sizing:content] placeholder:text-muted-foreground/70"
              />
              <div className="flex min-w-0 items-center gap-1.5">
                <div role="radiogroup" aria-label="AI provider" className={SEGMENT_TRACK}>
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={provider === p.id}
                      disabled={!providerReady(p.id, settings, ollamaModel)}
                      onClick={() => setProvider(p.id)}
                      className={cn(segmentClass(provider === p.id), 'px-2 disabled:opacity-35')}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <Combobox
                  className="h-7 min-w-0 flex-1 text-xs"
                  value={model}
                  onChange={setModel}
                  options={withCurrent}
                  placeholder="Model"
                  ariaLabel="Model"
                  emptyText={
                    provider === 'ollama'
                      ? 'No models found. Is Ollama running?'
                      : 'No models found.'
                  }
                />
                {/* Its own box, because a disabled button's tooltip wraps it in a span. */}
                <div className="flex shrink-0">
                  {pendingId ? (
                    <SimpleTooltip label="Stop">
                      <Button
                        type="button"
                        size="icon"
                        variant="soft"
                        aria-label="Stop"
                        onClick={stop}
                      >
                        <StopCircle className="h-3.5 w-3.5" />
                      </Button>
                    </SimpleTooltip>
                  ) : (
                    <SimpleTooltip label="Send (Enter)" wrapTrigger={!draft.trim() || !model}>
                      <Button
                        type="submit"
                        size="icon"
                        aria-label="Send"
                        disabled={!draft.trim() || !model}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                    </SimpleTooltip>
                  )}
                </div>
              </div>
            </div>
            {!model && (
              <p className="mt-1.5 px-2 text-[11px] text-muted-foreground">
                Choose a model to start.
              </p>
            )}
          </form>
        </>
      )}
    </aside>
  );
}
