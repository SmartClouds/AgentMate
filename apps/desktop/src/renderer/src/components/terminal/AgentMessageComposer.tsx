import type { AgentInstructionTarget } from '@runova/core';
import { MAX_SSH_AGENT_MESSAGE_CHARS } from '@shared/sshAgentMessage';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, Send, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { AgentPromptField } from './AgentPromptField';

/** How long "Sent" stays under the box. The run moves on, and the queued pill keeps the live state. */
const SENT_NOTE_MS = 6000;

/**
 * The box under an AI task's status bar for talking to a task that is already running: a
 * correction, a restriction, a new request. Enter sends, Shift+Enter starts a new line, Escape
 * closes it. It has the Build Prompt tools (dictation, Persian, translation, an AI rewrite). Used
 * by both the terminal and the Remote Desktop task bars.
 */
export function AgentMessageComposer({
  placeholder,
  sentNote,
  target,
  onSend,
  draft,
  onDraftChange,
  onClose,
  autoFocus = true,
}: {
  /** Says when the AI will get to read the message, which depends on what it is doing. */
  placeholder: string;
  /** The confirmation under the box, saying what happens to the message that was just sent. */
  sentNote: string;
  /** Where the task works, which shapes what "Write it for me" writes. */
  target: AgentInstructionTarget;
  /** Resolves false when the task has ended by now, so nothing was sent. */
  onSend: (text: string) => Promise<boolean>;
  /** Kept by the bar, so closing the box or an AI question in between does not lose the text. */
  draft: string;
  onDraftChange: (draft: string) => void;
  /** Absent where the box is always there, such as under the history's timeline. */
  onClose?: () => void;
  /** Focus the box when it appears. Off where it sits open beside other things. */
  autoFocus?: boolean;
}): React.JSX.Element {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  // An object, so two sends in a row each get the full time on screen.
  const [note, setNote] = useState<{ text: string } | null>(null);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), SENT_NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      if (await onSend(text)) {
        onDraftChange('');
        setNote({ text: sentNote });
      } else {
        // The text stays in the box, so nothing typed is lost.
        toast.error('The AI task has already ended, so nothing was sent.');
      }
    } catch {
      toast.error("Couldn't send the message. Try again.");
    } finally {
      setSending(false);
      fieldRef.current?.focus();
    }
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border/40 px-3 py-2">
      <div className="flex items-start gap-2">
        <AgentPromptField
          ref={fieldRef}
          autoFocus={autoFocus}
          value={draft}
          onChange={(value) => {
            onDraftChange(value);
            setNote(null);
          }}
          purpose="message"
          target={target}
          readOnly={sending}
          maxLength={MAX_SSH_AGENT_MESSAGE_CHARS}
          ariaLabel="Message to the AI"
          placeholder={placeholder}
          onSubmit={() => void submit()}
          onEscape={onClose}
          className="min-w-0 flex-1"
          trailing={
            <Button
              size="sm"
              aria-label="Send message"
              onClick={() => void submit()}
              disabled={!draft.trim() || sending}
              className="h-7 shrink-0 gap-1.5"
            >
              <Send className="h-3 w-3" />
              Send
            </Button>
          }
        />
        {onClose && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Close message box"
            onClick={onClose}
            className="mt-1.5 shrink-0"
          >
            <X />
          </Button>
        )}
      </div>
      <p
        role="status"
        className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground empty:hidden"
      >
        {note && (
          <>
            <CircleCheck className="h-3 w-3 shrink-0 text-primary" />
            {note.text}
          </>
        )}
      </p>
    </div>
  );
}
