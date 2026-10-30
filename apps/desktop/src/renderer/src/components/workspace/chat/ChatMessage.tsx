import type { ChatItem } from '@runova/core';
import { useState } from 'react';
import { MarkdownMessage } from '@/components/askAi/MarkdownMessage';
import { CliLogo } from '@/components/cliLogos';
import { ChevronRight, Sparkles } from '@/components/icons';
import { cn } from '@/lib/utils';
import type { ChatTheme } from './chatThemes';
import { ToolCallCard } from './ToolCallCard';

function Thinking({ text, theme }: { text: string; theme: ChatTheme }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('text-xs', open && theme.card)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex cursor-pointer items-center gap-1.5 px-1 py-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span className="font-medium">Thinking</span>
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="px-3 pb-2.5 pt-0.5 italic text-muted-foreground" dir="auto">
          <MarkdownMessage content={text} className="text-xs" />
        </div>
      ) : null}
    </div>
  );
}

export interface ChatMessageProps {
  item: ChatItem;
  theme: ChatTheme;
  cliId: string;
  /** The first part of a reply carries the CLI's mark; the rest line up under it. */
  startsReply: boolean;
}

/** One item of the conversation, drawn the way the CLI's own chat app would draw it. */
export function ChatMessage({
  item,
  theme,
  cliId,
  startsReply,
}: ChatMessageProps): React.JSX.Element {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end pl-12">
        <div
          dir="auto"
          className={cn(
            'max-w-[85%] whitespace-pre-wrap break-words px-4 py-2.5 text-sm',
            theme.userBubble,
          )}
        >
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === 'notice') {
    return (
      <div className="flex justify-center">
        <span
          className={cn(
            'rounded-full px-3 py-1 text-[11px]',
            item.tone === 'error'
              ? 'bg-destructive/10 text-destructive'
              : item.tone === 'warning'
                ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                : 'bg-foreground/[0.05] text-muted-foreground',
          )}
        >
          {item.text}
        </span>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="w-6 shrink-0 pt-0.5">
        {startsReply ? <CliLogo cliId={cliId} className="h-5 w-5" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        {item.kind === 'assistant' ? (
          <div dir="auto">
            <MarkdownMessage content={item.text} className={theme.replyText} />
          </div>
        ) : item.kind === 'thinking' ? (
          <Thinking text={item.text} theme={theme} />
        ) : (
          <ToolCallCard item={item} theme={theme} />
        )}
      </div>
    </div>
  );
}
