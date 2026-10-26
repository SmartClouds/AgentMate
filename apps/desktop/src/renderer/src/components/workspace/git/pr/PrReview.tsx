import {
  buildReviewFixPrompt,
  DEFAULT_REVIEW_COMMANDS,
  type Project,
  type PullRequestInfo,
} from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Check, MessageSquare, Robot, Send, Spinner, Wand2 } from '@/components/icons';
import { FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { MULTILINE_FIELD_RADIUS } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { FixWithAiDialog } from '../../FixWithAiDialog';
import { LocalReviewDialog } from './LocalReviewDialog';
import { isSubmitKey, PrCard, PrPill, type PrTone } from './PrCard';
import { ReviewThread } from './ReviewThread';
import { usePullRequestActions } from './usePullRequest';

export const REVIEW_DECISIONS: Record<string, { label: string; tone: PrTone }> = {
  APPROVED: { label: 'Approved', tone: 'success' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'destructive' },
  REVIEW_REQUIRED: { label: 'Review required', tone: 'warning' },
};

/** Review threads to answer or fix, plus one-click requests to review bots and a local AI review. */
export function PrReview({
  project,
  pr,
}: {
  project: Project;
  pr: PullRequestInfo;
}): React.JSX.Element {
  const actions = usePullRequestActions(project.id);
  const [showResolved, setShowResolved] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const open = pr.threads.filter((thread) => !thread.isResolved);
  const resolved = pr.threads.filter((thread) => thread.isResolved);
  const decision = pr.reviewDecision ? REVIEW_DECISIONS[pr.reviewDecision] : undefined;

  return (
    <PrCard
      title="Review"
      icon={MessageSquare}
      tone={decision?.tone === 'destructive' || open.length ? 'warning' : 'default'}
      summary={
        open.length
          ? `${open.length} open ${open.length === 1 ? 'thread' : 'threads'}`
          : decision?.label
      }
      actions={
        <SimpleTooltip label="Have the project CLI review the diff, then post it as a comment">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setReviewing(true)}
            className="text-muted-foreground"
          >
            <Robot />
            Review with AI
          </Button>
        </SimpleTooltip>
      }
    >
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 px-3.5">
          {decision ? <PrPill tone={decision.tone}>{decision.label}</PrPill> : null}
          {open.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">No open review comments.</span>
          ) : (
            <Button
              type="button"
              variant="tint"
              size="xs"
              onClick={() => setFixing(true)}
              className="ml-auto"
            >
              <Wand2 />
              Fix comments with AI
            </Button>
          )}
        </div>

        {open.length > 0 ? (
          <ul className="space-y-1.5">
            {open.map((thread) => (
              <ReviewThread
                key={thread.id}
                thread={thread}
                onReply={(body) => actions.reply(thread.id, body)}
                onResolve={(value) => void actions.resolveThread(thread.id, value)}
              />
            ))}
          </ul>
        ) : null}

        {resolved.length > 0 ? (
          <>
            <button
              type="button"
              onClick={() => setShowResolved((value) => !value)}
              className="mx-2 rounded-full px-1.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {showResolved ? 'Hide resolved' : `Show ${resolved.length} resolved`}
            </button>
            {showResolved ? (
              <ul className="space-y-1.5">
                {resolved.map((thread) => (
                  <ReviewThread
                    key={thread.id}
                    thread={thread}
                    onReply={(body) => actions.reply(thread.id, body)}
                    onResolve={(value) => void actions.resolveThread(thread.id, value)}
                  />
                ))}
              </ul>
            ) : null}
          </>
        ) : null}

        <CommentBox onPost={(body) => actions.comment(pr.number, body)} />
      </div>

      {fixing ? (
        <FixWithAiDialog
          project={project}
          open={fixing}
          onOpenChange={setFixing}
          title="Fix review comments with AI"
          description={`#${pr.number} · ${open.length} open ${open.length === 1 ? 'thread' : 'threads'}`}
          jobKey={`pr-review-fix:${project.id}:${pr.number}:${open.map((t) => t.id).join(',')}`}
          source={{ prompt: buildReviewFixPrompt(pr, open) }}
        />
      ) : null}
      {reviewing ? (
        <LocalReviewDialog
          project={project}
          pr={pr}
          open={reviewing}
          onOpenChange={setReviewing}
          onPost={(body) => actions.comment(pr.number, body)}
        />
      ) : null}
    </PrCard>
  );
}

/** A PR comment, with the configured review bot commands one click away. */
function CommentBox({ onPost }: { onPost: (body: string) => Promise<boolean> }): React.JSX.Element {
  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const commands = settings.data?.reviewCommands ?? [...DEFAULT_REVIEW_COMMANDS];
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);

  useEffect(() => {
    if (!posted) return;
    const timer = setTimeout(() => setPosted(false), 2500);
    return () => clearTimeout(timer);
  }, [posted]);

  async function post(): Promise<void> {
    if (!body.trim() || posting) return;
    setPosting(true);
    try {
      if (await onPost(body.trim())) {
        setBody('');
        setPosted(true);
      }
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className={cn(FOOTER_HAIRLINE, 'mx-2 space-y-1.5 pt-2.5')}>
      {commands.length > 0 ? (
        <div className="flex flex-wrap gap-1" aria-label="Review commands">
          {commands.map((command) => (
            <button
              key={command}
              type="button"
              onClick={() => setBody(command)}
              // A filter chip's look at the panel's size; the edge is a ring so the global
              // border colour can't repaint it.
              className="inline-flex h-5 cursor-pointer items-center rounded-full bg-foreground/[0.05] px-2 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-foreground/[0.07] transition-colors hover:bg-primary/12 hover:text-primary hover:ring-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {command}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        rows={2}
        value={body}
        aria-label="Comment on the pull request"
        placeholder="Comment or a review command… (Ctrl+Enter to post)"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (isSubmitKey(event)) {
            event.preventDefault();
            void post();
          }
        }}
        className={cn(
          'field-surface block w-full resize-y px-3 py-1.5 text-[12px] outline-none',
          MULTILINE_FIELD_RADIUS,
        )}
      />
      <div className="flex items-center justify-end gap-2">
        {posted ? (
          <span role="status" className="inline-flex items-center gap-1 text-[11px] text-success">
            <Check className="h-2.5 w-2.5" />
            Posted
          </span>
        ) : null}
        <Button
          type="button"
          size="xs"
          onClick={() => void post()}
          disabled={!body.trim() || posting}
        >
          {posting ? <Spinner className="animate-spin motion-reduce:animate-none" /> : <Send />}
          Post comment
        </Button>
      </div>
    </div>
  );
}
