import type { PrReviewComment, PrReviewThread } from '@runova/core';
import { useState } from 'react';
import { Check, MessageSquare, Send, Spinner, Undo } from '@/components/icons';
import { Chip, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { MULTILINE_FIELD_RADIUS } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { isSubmitKey } from './PrCard';

function Comment({ comment }: { comment: PrReviewComment }): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] text-muted-foreground">
        <span className="font-semibold text-foreground/85">@{comment.author}</span>
        {comment.createdAt ? ` · ${timeAgo(comment.createdAt)}` : null}
      </p>
      <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">{comment.body}</p>
    </div>
  );
}

/** One review thread: where it is, the latest comment, and reply / resolve right there. */
export function ReviewThread({
  thread,
  onReply,
  onResolve,
}: {
  thread: PrReviewThread;
  onReply: (body: string) => Promise<boolean>;
  onResolve: (resolved: boolean) => void;
}): React.JSX.Element {
  const [showEarlier, setShowEarlier] = useState(false);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const where = thread.line ? `${thread.path}:${thread.line}` : thread.path;
  const earlier = thread.comments.slice(0, -1);
  const latest = thread.comments.at(-1);

  async function send(): Promise<void> {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      if (await onReply(reply.trim())) {
        setReply('');
        setReplying(false);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <li
      className={cn(
        SECTION_WELL,
        'mx-2 space-y-1.5 px-2.5 py-2',
        thread.isResolved && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-1.5">
        <SimpleTooltip label={where} wrapTrigger>
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
            {where}
          </span>
        </SimpleTooltip>
        {thread.isOutdated ? <Chip className="h-4 px-1.5 text-[10px]">outdated</Chip> : null}
      </div>

      {earlier.length > 0 && !showEarlier ? (
        <button
          type="button"
          onClick={() => setShowEarlier(true)}
          className="text-[10.5px] font-medium text-primary hover:underline"
        >
          Show {earlier.length} earlier {earlier.length === 1 ? 'comment' : 'comments'}
        </button>
      ) : null}
      {showEarlier
        ? earlier.map((comment) => (
            <Comment key={comment.url || comment.createdAt} comment={comment} />
          ))
        : null}
      {latest ? <Comment comment={latest} /> : null}

      {replying ? (
        <div className="space-y-1">
          <textarea
            autoFocus
            rows={2}
            value={reply}
            aria-label={`Reply to ${where}`}
            placeholder="Reply… (Ctrl+Enter to send)"
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (isSubmitKey(event)) {
                event.preventDefault();
                void send();
              } else if (event.key === 'Escape') {
                setReplying(false);
              }
            }}
            className={cn(
              'field-surface block w-full resize-y px-3 py-1.5 text-[12px] outline-none',
              MULTILINE_FIELD_RADIUS,
            )}
          />
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setReplying(false)}
              className="text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              onClick={() => void send()}
              disabled={!reply.trim() || sending}
            >
              {sending ? <Spinner className="animate-spin motion-reduce:animate-none" /> : <Send />}
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setReplying(true)}
            className="text-muted-foreground"
          >
            <MessageSquare />
            Reply
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`${thread.isResolved ? 'Unresolve' : 'Resolve'} ${where}`}
            onClick={() => onResolve(!thread.isResolved)}
            className="text-muted-foreground"
          >
            {thread.isResolved ? <Undo /> : <Check />}
            {thread.isResolved ? 'Unresolve' : 'Resolve'}
          </Button>
        </div>
      )}
    </li>
  );
}
