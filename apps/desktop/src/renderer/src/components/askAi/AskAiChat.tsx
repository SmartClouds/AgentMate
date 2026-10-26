import { GEMINI_API_MODELS, OPENAI_API_MODELS } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { GrammarTextarea } from '@/components/grammar/GrammarTextarea';
import {
  ArrowUp,
  Bookmark,
  Copy,
  History,
  MessageSquare,
  RefreshCw,
  Robot,
  SettingsIcon,
  Trash2,
  TriangleAlert,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { type AskAiMessage, useAskAiStore } from '@/stores/askAiStore';
import type { AiProvider } from '../../../../shared/apiTypes';
import { MarkdownMessage } from './MarkdownMessage';

const OPENAI_MODEL_OPTIONS = [...OPENAI_API_MODELS];
const GEMINI_MODEL_OPTIONS = [...GEMINI_API_MODELS];

/** The list, plus the saved model when the catalog has since dropped it, so the picker never looks empty. */
function withCurrent(options: { value: string; label: string }[], current: string) {
  if (!current || options.some((o) => o.value === current)) return options;
  return [{ value: current, label: current }, ...options];
}

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
};

const SUGGESTIONS = [
  'Summarize what this project does',
  'Help me write a commit message',
  'Explain an error I ran into',
];

/** The model picker in the composer's bottom row: a small pill rather than a form field. */
const MODEL_PICKER = 'search-pill h-7 w-44 rounded-full px-3 text-xs';

export interface AskAiChatProps {
  className?: string;
  /** 'modal' trims the message list to a fixed height for use inside a popover/dialog. */
  variant?: 'page' | 'modal';
  onRequestViewHistory?: () => void;
}

export function AskAiChat({
  className,
  variant = 'page',
  onRequestViewHistory,
}: AskAiChatProps): React.JSX.Element {
  const navigate = useNavigate();
  const provider = useAskAiStore((s) => s.provider);
  const setProvider = useAskAiStore((s) => s.setProvider);
  const openaiModel = useAskAiStore((s) => s.openaiModel);
  const setOpenaiModel = useAskAiStore((s) => s.setOpenaiModel);
  const ollamaModel = useAskAiStore((s) => s.ollamaModel);
  const setOllamaModel = useAskAiStore((s) => s.setOllamaModel);
  const geminiModel = useAskAiStore((s) => s.geminiModel);
  const setGeminiModel = useAskAiStore((s) => s.setGeminiModel);
  const messages = useAskAiStore((s) => s.messages);
  const addMessage = useAskAiStore((s) => s.addMessage);
  const clearMessages = useAskAiStore((s) => s.clearMessages);
  const toggleBookmark = useAskAiStore((s) => s.toggleBookmark);
  const replaceMessage = useAskAiStore((s) => s.replaceMessage);

  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reduceMotion = useReducedMotion();

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: only seed each field once, the first time settings arrive with nothing chosen yet
  useEffect(() => {
    if (!settingsQuery.data) return;
    if (!openaiModel) setOpenaiModel(settingsQuery.data.openaiModel);
    if (!ollamaModel) setOllamaModel(settingsQuery.data.ollamaModel);
    if (!geminiModel) setGeminiModel(settingsQuery.data.geminiModel);
  }, [settingsQuery.data]);

  const ollamaModelsQuery = useQuery({
    queryKey: ['ollama-models'],
    queryFn: () => window.runova.ai.listOllamaModels(),
    enabled: provider === 'ollama',
    retry: false,
  });

  const geminiModelsQuery = useQuery({
    queryKey: ['gemini-models'],
    queryFn: () => window.runova.ai.listGeminiModels(),
    enabled: provider === 'gemini' && !!settingsQuery.data?.geminiApiKey,
    retry: false,
  });

  useEffect(() => {
    if (geminiModelsQuery.error) {
      toast.error((geminiModelsQuery.error as Error).message || 'Failed to load Gemini models.');
    }
    // Only fire when a fetch attempt actually resolves to an error, not on every render.
  }, [geminiModelsQuery.error]);

  const geminiModelOptions = geminiModelsQuery.data?.length
    ? geminiModelsQuery.data.map((name) => ({ value: name, label: name }))
    : geminiModelsQuery.isError
      ? []
      : GEMINI_MODEL_OPTIONS;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message is what should scroll the chat to the bottom
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: variant === 'modal' ? 'auto' : 'smooth' });
  }, [messages, variant]);

  const model =
    provider === 'openai' ? openaiModel : provider === 'gemini' ? geminiModel : ollamaModel;

  async function handleSend(): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (!model.trim()) {
      toast.error(`Choose a ${PROVIDER_LABEL[provider]} model first.`);
      return;
    }

    // Conversation so far, oldest first, so the provider has context from prior turns.
    const history = messages
      .filter(
        (m): m is typeof m & { role: 'user' | 'assistant' } =>
          m.role === 'user' || m.role === 'assistant',
      )
      .map((m) => ({ role: m.role, content: m.content }));

    addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      provider,
      model,
      createdAt: new Date().toISOString(),
    });
    setPrompt('');
    setSending(true);
    try {
      const result = await window.runova.ai.ask({ provider, model, prompt: trimmed, history });
      addMessage({
        id: crypto.randomUUID(),
        role: result.ok ? 'assistant' : 'error',
        content: result.ok ? result.text : (result.error ?? 'Something went wrong.'),
        provider,
        model,
        createdAt: new Date().toISOString(),
      });
    } finally {
      setSending(false);
    }
  }

  async function handleRetry(errorMessage: AskAiMessage): Promise<void> {
    const idx = messages.findIndex((m) => m.id === errorMessage.id);
    const userMessage = idx > 0 ? messages[idx - 1] : undefined;
    if (!userMessage || userMessage.role !== 'user') return;

    const history = messages
      .slice(0, idx - 1)
      .filter(
        (m): m is typeof m & { role: 'user' | 'assistant' } =>
          m.role === 'user' || m.role === 'assistant',
      )
      .map((m) => ({ role: m.role, content: m.content }));

    setSending(true);
    try {
      const result = await window.runova.ai.ask({
        provider: errorMessage.provider,
        model: errorMessage.model,
        prompt: userMessage.content,
        history,
      });
      replaceMessage(errorMessage.id, {
        id: crypto.randomUUID(),
        role: result.ok ? 'assistant' : 'error',
        content: result.ok ? result.text : (result.error ?? 'Something went wrong.'),
        provider: errorMessage.provider,
        model: errorMessage.model,
        createdAt: new Date().toISOString(),
      });
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleSuggestionClick(suggestion: string): void {
    setPrompt(suggestion);
    textareaRef.current?.focus();
  }

  async function handleCopy(content: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      toast.success('Copied to clipboard.');
    } catch {
      toast.error('Could not copy to clipboard.');
    }
  }

  const configured =
    provider === 'openai'
      ? !!settingsQuery.data?.openaiApiKey
      : provider === 'gemini'
        ? !!settingsQuery.data?.geminiApiKey
        : true;

  const isModal = variant === 'modal';
  const providerItems: { value: AiProvider; label: string }[] = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'ollama', label: 'Ollama' },
  ];
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', className)}>
      <div
        className={cn(
          'rail-scroll min-h-0 overflow-y-auto',
          isModal
            ? 'h-[420px] flex-none rounded-2xl bg-foreground/[0.025] ring-1 ring-inset ring-foreground/[0.06]'
            : 'flex-1',
        )}
      >
        <div
          className={cn(
            'mx-auto flex w-full flex-col gap-5',
            isModal ? 'p-4' : 'min-h-full max-w-3xl px-5 pb-6 pt-6',
          )}
        >
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 py-12 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
                <MessageSquare className="h-6 w-6" />
              </div>
              <div className="max-w-sm space-y-1.5">
                <p className="text-base font-semibold tracking-tight">What can I help with?</p>
                <p className="text-sm text-muted-foreground">
                  Ask anything, responses come straight from {PROVIDER_LABEL[provider]}.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2 px-4">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleSuggestionClick(s)}
                    className="search-pill cursor-pointer rounded-full px-3.5 py-1.5 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="group ml-auto flex max-w-[80%] flex-col items-end gap-1">
                  <div className="whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-primary/12 px-4 py-2.5 text-sm text-foreground ring-1 ring-inset ring-primary/15">
                    {m.content}
                  </div>
                  <MessageActions
                    message={m}
                    onCopy={handleCopy}
                    onToggleBookmark={toggleBookmark}
                  />
                </div>
              ) : (
                <div key={m.id} className="group mr-auto flex w-full items-start gap-3">
                  <div
                    className={cn(
                      'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                      m.role === 'error'
                        ? 'bg-destructive/12 text-destructive'
                        : 'bg-primary/12 text-primary shadow-[0_0_24px_-10px_hsl(var(--primary)/0.8)]',
                    )}
                  >
                    {m.role === 'error' ? (
                      <TriangleAlert className="h-3.5 w-3.5" />
                    ) : (
                      <Robot className="h-3.5 w-3.5" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {m.role === 'error' ? (
                      // A ring rather than a border, so the red is not lost to the theme's border colour.
                      <div className="rounded-2xl bg-destructive/[0.06] px-4 py-2.5 text-sm text-destructive ring-1 ring-inset ring-destructive/25">
                        <span className="whitespace-pre-wrap">{m.content}</span>
                      </div>
                    ) : (
                      <div className="pt-0.5 text-foreground">
                        <MarkdownMessage content={m.content} />
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {PROVIDER_LABEL[m.provider]} · {m.model}
                      </span>
                      {m.role === 'error' && (
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => void handleRetry(m)}
                          className="flex cursor-pointer items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
                        >
                          <RefreshCw className="h-2.5 w-2.5" /> Retry
                        </button>
                      )}
                      <MessageActions
                        message={m}
                        onCopy={handleCopy}
                        onToggleBookmark={toggleBookmark}
                      />
                    </div>
                  </div>
                </div>
              ),
            )
          )}
          {sending && (
            <div
              role="status"
              aria-label="Waiting for the answer"
              className="mr-auto flex items-center gap-3"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Robot className="h-3.5 w-3.5" />
              </div>
              <div className="flex items-center gap-1 rounded-full bg-foreground/[0.06] px-3.5 py-2.5">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
              </div>
            </div>
          )}
          <div ref={scrollEndRef} />
        </div>
      </div>

      {/* The composer: one rounded pill like the search box, the question on top and the
          provider, the model and Send along its bottom edge, the way ChatGPT's reads. */}
      <div className={cn('shrink-0', isModal ? 'pt-3' : 'px-4 pb-4 pt-1')}>
        <div className={cn('mx-auto w-full', !isModal && 'max-w-3xl')}>
          <div className="search-pill flex flex-col gap-1 rounded-[26px] p-2 transition-colors">
            <GrammarTextarea
              ref={textareaRef}
              containerClassName="w-full"
              // The counter would sit on top of the last line of a short question,
              // and the right-click menu is the useful part in a chat box anyway.
              hideCounter
              aria-label="Ask a question"
              className="max-h-48 min-h-[44px] w-full resize-none border-none bg-transparent px-2.5 py-2 text-[15px] shadow-none [field-sizing:content] placeholder:text-muted-foreground/70 hover:border-transparent focus-visible:ring-0"
              placeholder="Ask anything"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <LayoutGroup id={`ask-ai-provider-${variant}`}>
                <div
                  role="group"
                  aria-label="Provider"
                  className="flex items-center gap-0.5 rounded-full bg-foreground/[0.05] p-0.5"
                >
                  {providerItems.map((item) => {
                    const active = provider === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setProvider(item.value)}
                        className={cn(
                          'relative isolate flex h-7 cursor-pointer items-center rounded-full px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                          active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {active && (
                          <motion.span
                            aria-hidden
                            layoutId={`ask-ai-provider-active-${variant}`}
                            transition={pillTransition}
                            className="absolute inset-0 -z-10 rounded-full bg-primary/12 ring-1 ring-inset ring-primary/20"
                          />
                        )}
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </LayoutGroup>

              {provider === 'openai' && (
                <Combobox
                  className={MODEL_PICKER}
                  value={openaiModel}
                  onChange={setOpenaiModel}
                  options={withCurrent(OPENAI_MODEL_OPTIONS, openaiModel)}
                  placeholder="Model"
                  ariaLabel="Model"
                />
              )}
              {provider === 'gemini' && (
                <>
                  <Combobox
                    className={MODEL_PICKER}
                    value={geminiModel}
                    onChange={setGeminiModel}
                    options={geminiModelOptions}
                    placeholder={geminiModelsQuery.isFetching ? 'Loading models…' : 'Model'}
                    ariaLabel="Model"
                    emptyText={
                      geminiModelsQuery.isError
                        ? 'Could not load models, check your API key.'
                        : 'No models found.'
                    }
                  />
                  {!!settingsQuery.data?.geminiApiKey && (
                    <SimpleTooltip label="Reload the model list">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Reload the model list"
                        className="shrink-0"
                        disabled={geminiModelsQuery.isFetching}
                        onClick={() => void geminiModelsQuery.refetch()}
                      >
                        <RefreshCw
                          className={cn(
                            'h-3.5 w-3.5',
                            geminiModelsQuery.isFetching && 'animate-spin',
                          )}
                        />
                      </Button>
                    </SimpleTooltip>
                  )}
                </>
              )}
              {provider === 'ollama' && (
                <>
                  <Combobox
                    className={MODEL_PICKER}
                    value={ollamaModel}
                    onChange={setOllamaModel}
                    options={(ollamaModelsQuery.data ?? []).map((name) => ({
                      value: name,
                      label: name,
                    }))}
                    placeholder={
                      ollamaModelsQuery.isFetching ? 'Loading models…' : 'Choose a model'
                    }
                    ariaLabel="Model"
                    emptyText="No models found. Is Ollama running?"
                  />
                  <SimpleTooltip label="Reload the model list">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Reload the model list"
                      className="shrink-0"
                      disabled={ollamaModelsQuery.isFetching}
                      onClick={() => void ollamaModelsQuery.refetch()}
                    >
                      <RefreshCw
                        className={cn(
                          'h-3.5 w-3.5',
                          ollamaModelsQuery.isFetching && 'animate-spin',
                        )}
                      />
                    </Button>
                  </SimpleTooltip>
                </>
              )}
              {!configured && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="bg-warning/12 text-warning hover:bg-warning/20 hover:text-warning"
                  onClick={() => navigate('/settings')}
                >
                  <SettingsIcon className="h-3 w-3" /> Add API key
                </Button>
              )}

              {/* Its own box, because a disabled button's tooltip wraps it in a span. */}
              <div className="ml-auto flex shrink-0">
                <SimpleTooltip label="Send (Enter)" wrapTrigger={sending || !prompt.trim()}>
                  <Button
                    size="icon"
                    aria-label="Send"
                    className="h-9 w-9 shrink-0"
                    disabled={sending || !prompt.trim()}
                    onClick={() => void handleSend()}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                </SimpleTooltip>
              </div>
            </div>
          </div>
          {!isModal && (
            <p className="pt-2 text-center text-[11px] text-muted-foreground/80">
              Enter to send, Shift+Enter for a new line.
            </p>
          )}
        </div>
      </div>

      {isModal && messages.length > 0 && (
        <div className="flex items-center justify-center gap-2 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1 px-2.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={clearMessages}
          >
            <Trash2 className="h-3 w-3" /> Clear
          </Button>
          {onRequestViewHistory && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1 px-2.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
              onClick={onRequestViewHistory}
            >
              <History className="h-3 w-3" /> View full history
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

interface MessageActionsProps {
  message: AskAiMessage;
  onCopy: (content: string) => void;
  onToggleBookmark: (id: string) => void;
}

const MESSAGE_ACTION =
  'flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function MessageActions({
  message,
  onCopy,
  onToggleBookmark,
}: MessageActionsProps): React.JSX.Element {
  return (
    // Quiet until the message is hovered or focused, except a bookmark, which stays in view.
    <div className="flex items-center gap-0.5">
      <SimpleTooltip label="Copy message">
        <button
          type="button"
          aria-label="Copy message"
          onClick={() => onCopy(message.content)}
          className={cn(
            MESSAGE_ACTION,
            'text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <Copy className="h-3 w-3" />
        </button>
      </SimpleTooltip>
      <SimpleTooltip label={message.bookmarked ? 'Remove bookmark' : 'Bookmark message'}>
        <button
          type="button"
          aria-label={message.bookmarked ? 'Remove bookmark' : 'Bookmark message'}
          aria-pressed={message.bookmarked ?? false}
          onClick={() => onToggleBookmark(message.id)}
          className={cn(
            MESSAGE_ACTION,
            message.bookmarked
              ? 'text-primary'
              : 'text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <Bookmark className="h-3 w-3" />
        </button>
      </SimpleTooltip>
    </div>
  );
}
