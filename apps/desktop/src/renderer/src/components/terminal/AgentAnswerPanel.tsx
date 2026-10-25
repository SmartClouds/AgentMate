import type { AgentInstructionTarget } from '@agentmat/core';
import { MAX_SSH_AGENT_MESSAGE_CHARS } from '@shared/sshAgentMessage';
import { CircleQuestion, Send } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { CollapsibleText } from '@/components/ui/collapsible-text';
import { AgentPromptField } from './AgentPromptField';

/** About three lines of the question before the rest folds behind Show more. */
const QUESTION_COLLAPSED_PX = 64;

/**
 * The AI's question in full, with the box to answer it. The status bar has room for a line, which
 * cuts most questions off, so this sits under it while the AI waits. The answer box is the same as
 * every other one: dictation, Persian, a translation, or the AI writing the answer from a note.
 */
export function AgentAnswerPanel({
  question,
  target,
  draft,
  onDraftChange,
  onAnswer,
  autoFocus = true,
}: {
  question: string;
  target: AgentInstructionTarget;
  /** Kept by the caller, so the answer survives the panel closing and opening again. */
  draft: string;
  onDraftChange: (draft: string) => void;
  onAnswer: (answer: string) => void;
  autoFocus?: boolean;
}): React.JSX.Element {
  function submit(): void {
    const answer = draft.trim();
    if (!answer) return;
    onAnswer(answer);
    onDraftChange('');
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border/40 px-3 py-2">
      <section aria-label="The AI asks" className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          <CircleQuestion className="h-3 w-3" />
          The AI asks
        </span>
        <CollapsibleText
          text={question}
          collapsedHeight={QUESTION_COLLAPSED_PX}
          className="px-3 py-2 text-xs leading-5"
        />
      </section>
      <AgentPromptField
        value={draft}
        onChange={onDraftChange}
        purpose="answer"
        target={target}
        question={question}
        ariaLabel="Your answer"
        placeholder="Your answer… Type it, dictate it, or write it in Persian"
        maxLength={MAX_SSH_AGENT_MESSAGE_CHARS}
        onSubmit={submit}
        autoFocus={autoFocus}
        trailing={
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0 gap-1.5"
            disabled={!draft.trim()}
            onClick={submit}
          >
            <Send className="h-3 w-3" />
            Send answer
          </Button>
        }
      />
    </div>
  );
}
