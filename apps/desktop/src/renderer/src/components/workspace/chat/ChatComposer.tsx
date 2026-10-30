import { forwardRef, useState } from 'react';
import { Send, StopCircle } from '@/components/icons';
import { AgentPromptField } from '@/components/terminal/AgentPromptField';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { terminalRuntime } from '@/lib/terminal/terminalRuntime';
import { cn } from '@/lib/utils';
import { useAgentChatStore } from '@/stores/agentChatStore';
import type { ChatTheme } from './chatThemes';

/** Gives the CLI a moment to take the paste in before Enter submits it, as Relay does. */
const SUBMIT_DELAY_MS = 150;

export interface ChatComposerProps {
  sessionId: string;
  theme: ChatTheme;
  working: boolean;
}

/**
 * The chat view's message box. It is the same box as the SSH and Remote Desktop prompts, so it
 * has dictation, Persian, translation to English and an AI rewrite. A message is pasted into the
 * CLI running underneath and submitted, exactly as if it had been typed there.
 */
export const ChatComposer = forwardRef<HTMLTextAreaElement, ChatComposerProps>(
  function ChatComposer({ sessionId, theme, working }, ref) {
    const draft = useAgentChatStore((s) => s.drafts[sessionId] ?? '');
    const setDraft = useAgentChatStore((s) => s.setDraft);
    const [note, setNote] = useState<string | null>(null);

    function send(): void {
      const text = draft.trim();
      if (!text) return;
      if (!terminalRuntime.insertText(sessionId, text)) {
        setNote(`${theme.name} isn't ready for a message yet. Try again in a moment.`);
        return;
      }
      setDraft(sessionId, '');
      setNote(null);
      setTimeout(() => void window.runova.terminal.write(sessionId, '\r'), SUBMIT_DELAY_MS);
    }

    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {note ? (
          <p role="status" className="px-2 pb-1.5 text-[11px] text-muted-foreground">
            {note}
          </p>
        ) : null}
        <AgentPromptField
          ref={ref}
          value={draft}
          onChange={(value) => {
            setDraft(sessionId, value);
            setNote(null);
          }}
          purpose="message"
          target="local"
          submitOn="enter"
          ariaLabel={`Message to ${theme.name}`}
          placeholder={`Message ${theme.name}…`}
          onSubmit={send}
          minHeight={44}
          maxHeight={200}
          className="rounded-[22px] bg-background/80 shadow-sm backdrop-blur"
          textClassName="text-sm"
          trailing={
            <div className="flex items-center gap-1">
              {working ? (
                <SimpleTooltip label={`Stop ${theme.name} (Esc)`}>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label="Stop"
                    className="h-8 w-8 rounded-full p-0"
                    onClick={() => void window.runova.terminal.write(sessionId, '\x1b')}
                  >
                    <StopCircle className="h-4 w-4" />
                  </Button>
                </SimpleTooltip>
              ) : null}
              <Button
                type="button"
                size="sm"
                aria-label="Send"
                disabled={!draft.trim()}
                className={cn('h-8 w-8 rounded-full p-0 disabled:opacity-40', theme.accentButton)}
                onClick={send}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          }
        />
      </div>
    );
  },
);
