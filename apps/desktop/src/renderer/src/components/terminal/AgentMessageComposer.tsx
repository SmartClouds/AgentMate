import { MAX_SSH_AGENT_MESSAGE_CHARS } from '@shared/sshAgentMessage';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, Send, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/** The tallest the message box grows before it scrolls, about five lines. */
const COMPOSER_MAX_HEIGHT_PX = 112;
/** How long "Sent" stays under the box. The run moves on, and the queued pill keeps the live state. */
const SENT_NOTE_MS = 6000;

/**
 * The box under an AI task's status bar for talking to a task that is already running: a
 * correction, a restriction, a new request. Enter sends, Shift+Enter starts a new line, Escape
 * closes it. Used by both the terminal and the Remote Desktop task bars.
 */
export function AgentMessageComposer({
  placeholder,
  sentNote,
  onSend,
  draft,
  onDraftChange,
  onClose,
}: {
  /** Says when the AI will get to read the message, which depends on what it is doing. */
  placeholder: string;
  /** The confirmation under the box, saying what happens to the message that was just sent. */
  sentNote: string;
  /** Resolves false when the task has ended by now, so nothing was sent. */
  onSend: (text: string) => Promise<boolean>;
  /** Kept by the bar, so closing the box or an AI question in between does not lose the text. */
  draft: string;
  onDraftChange: (draft: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  // An object, so two sends in a row each get the full time on screen.
  const [note, setNote] = useState<{ text: string } | null>(null);

  // Grow with the text, like a chat box, up to a few lines.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field || !draft.length) return;
    field.style.height = 'auto';
    if (field.scrollHeight > 0) {
      // scrollHeight leaves out the border, but the height is set on the border box, so
      // without it the box comes up a few pixels short and shows a scrollbar.
      const needed = field.scrollHeight + (field.offsetHeight - field.clientHeight);
      field.style.height = `${Math.min(needed, COMPOSER_MAX_HEIGHT_PX)}px`;
      field.style.overflowY = needed > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
    }
  }, [draft]);

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
        if (fieldRef.current) {
          fieldRef.current.style.height = '';
          fieldRef.current.style.overflowY = '';
        }
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
      <div className="flex items-end gap-2">
        <Textarea
          ref={fieldRef}
          autoFocus
          rows={1}
          value={draft}
          readOnly={sending}
          maxLength={MAX_SSH_AGENT_MESSAGE_CHARS}
          aria-label="Message to the AI"
          placeholder={placeholder}
          onChange={(e) => {
            onDraftChange(e.target.value);
            setNote(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
              return;
            }
            // Enter while an input method is composing picks a candidate rather than sending.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          className="min-h-8 flex-1 resize-none overflow-y-hidden py-1.5 text-xs leading-5"
          style={{ maxHeight: COMPOSER_MAX_HEIGHT_PX }}
        />
        <Button
          size="sm"
          aria-label="Send message"
          onClick={() => void submit()}
          disabled={!draft.trim() || sending}
          className="shrink-0 gap-1.5"
        >
          <Send className="h-3 w-3" />
          Send
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close message box"
          onClick={onClose}
          className="mb-1 shrink-0"
        >
          <X />
        </Button>
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
