import type { ChatItem } from '@runova/core';
import { motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CliLogo } from '@/components/cliLogos';
import { ArrowDown, TerminalSquare, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { openAgentChat, useAgentChatStore } from '@/stores/agentChatStore';
import {
  tabRunLine,
  useAgentRunInfo,
  useAgentStatus,
  useCliRunLine,
} from '@/stores/agentStatusStore';
import type { WorkspaceTerminalTab } from '@/stores/workspaceStore';
import { ChatComposer } from './ChatComposer';
import { ChatMessage } from './ChatMessage';
import { type ChatTheme, chatThemeFor } from './chatThemes';

/** How close to the bottom still counts as reading the newest message. */
const STICK_PX = 48;

export interface AgentChatViewProps {
  projectId: string;
  tab: WorkspaceTerminalTab;
  /** Pulls keyboard focus into the message box when the tab becomes the focused one. */
  focused: boolean;
  /** Switches the tab back to its CLI, for anything the chat cannot answer. */
  onShowCli: () => void;
}

function startsReply(items: ChatItem[], index: number): boolean {
  const previous = items[index - 1];
  return !previous || previous.kind === 'user' || previous.kind === 'notice';
}

function EmptyState({
  theme,
  cliId,
  title,
  body,
}: {
  theme: ChatTheme;
  cliId: string;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
      <div className={cn('flex h-16 w-16 items-center justify-center rounded-3xl', theme.glow)}>
        <CliLogo cliId={cliId} className="h-8 w-8" />
      </div>
      <div className="max-w-xs space-y-1">
        <p className="text-base font-semibold tracking-tight">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function WorkingDots({ theme }: { theme: ChatTheme }): React.JSX.Element {
  return (
    <div className="flex gap-3">
      <div className="w-6 shrink-0" />
      <div className={cn('flex items-center gap-1 py-2', theme.accentText)} aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
      </div>
    </div>
  );
}

/**
 * A Workspace agent tab shown as a chat. The CLI keeps running in its terminal underneath; this
 * reads the transcript the CLI writes and types what is sent here into the CLI.
 */
export function AgentChatView({
  projectId: _projectId,
  tab,
  focused,
  onShowCli,
}: AgentChatViewProps): React.JSX.Element {
  const cliId = tab.cliId ?? '';
  const theme = chatThemeFor(tab.cliId);
  const chat = useAgentChatStore((s) => s.chats[tab.id]);
  const status = useAgentStatus(tab.id);
  const runInfo = useAgentRunInfo(tab.id);
  const cliRunLine = useCliRunLine(tab.cliId);
  const runLine = tabRunLine(runInfo, tab.runLabel, cliRunLine);
  const reduceMotion = useReducedMotion();
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one subscription per session; the tab's other fields only matter when it opens
  useEffect(() => openAgentChat(tab), [tab.id]);

  useLayoutEffect(() => {
    if (focused) composerRef.current?.focus();
  }, [focused]);

  const items = chat?.state.items ?? [];
  const working = status === 'working';

  // New lines keep the newest message in view, unless the user scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the conversation as it grows
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && atBottom.current) log.scrollTop = log.scrollHeight;
  }, [items.length, items[items.length - 1], working]);

  const onScroll = useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < STICK_PX;
    atBottom.current = near;
    setScrolledUp(!near);
  }, []);

  function jumpToLatest(): void {
    const log = logRef.current;
    if (!log) return;
    if (typeof log.scrollTo === 'function') {
      log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
    } else {
      log.scrollTop = log.scrollHeight;
    }
    atBottom.current = true;
    setScrolledUp(false);
  }

  return (
    <section
      aria-label={`${theme.name} chat`}
      className={cn('absolute inset-0 flex flex-col', theme.surface)}
    >
      <header className={cn('flex h-10 shrink-0 items-center gap-2.5 px-4', theme.header)}>
        <CliLogo cliId={cliId} className="h-4 w-4" />
        <span className="text-[13px] font-semibold">{theme.name}</span>
        {runLine ? <span className="truncate text-xs text-muted-foreground">{runLine}</span> : null}
        <span className="flex-1" />
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            working
              ? cn('shimmer', theme.accentText)
              : status === 'needs-input'
                ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                : 'text-muted-foreground',
          )}
        >
          {working ? 'Working' : status === 'needs-input' ? 'Needs you' : 'Ready'}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={onShowCli}
        >
          <TerminalSquare className="h-3.5 w-3.5" />
          CLI
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={logRef}
          role="log"
          aria-label="Conversation"
          onScroll={onScroll}
          className="absolute inset-0 overflow-y-auto"
        >
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 px-4 py-6">
            {!chat || chat.status === 'loading' ? (
              <div className="space-y-4" aria-hidden="true">
                <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : chat.status === 'waiting' ? (
              <EmptyState
                theme={theme}
                cliId={cliId}
                title={`Waiting for ${theme.name}`}
                body="The conversation shows here as soon as the CLI starts it."
              />
            ) : items.length === 0 ? (
              <EmptyState
                theme={theme}
                cliId={cliId}
                title="What should we build?"
                body={`Send a message and ${theme.name} gets to work in this project.`}
              />
            ) : (
              items.map((item, index) => (
                <motion.div
                  key={item.key}
                  initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  <ChatMessage
                    item={item}
                    theme={theme}
                    cliId={cliId}
                    startsReply={startsReply(items, index)}
                  />
                </motion.div>
              ))
            )}
            {working && chat?.status === 'ready' ? <WorkingDots theme={theme} /> : null}
          </div>
        </div>
        {scrolledUp ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 py-1.5 text-[11px] font-medium shadow-md backdrop-blur transition-colors hover:bg-background"
          >
            <ArrowDown className="h-3 w-3" />
            Jump to latest
          </button>
        ) : null}
      </div>

      {status === 'needs-input' ? (
        <div className="mx-auto w-full max-w-3xl px-4 pb-2">
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-2.5 text-sm"
          >
            <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="min-w-0 flex-1">{theme.name} is asking you something</span>
            <Button
              type="button"
              size="sm"
              className={cn('h-7 rounded-full px-3 text-xs', theme.accentButton)}
              onClick={() => void window.runova.terminal.write(tab.id, '\r')}
            >
              Allow
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => void window.runova.terminal.write(tab.id, '\x1b')}
            >
              Deny
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 rounded-full px-3 text-xs"
              onClick={onShowCli}
            >
              Show in CLI
            </Button>
          </div>
        </div>
      ) : null}

      <ChatComposer ref={composerRef} sessionId={tab.id} theme={theme} working={working} />
    </section>
  );
}
