import type { AgentRunInfo } from '@shared/apiTypes';
import { forwardRef, useState } from 'react';
import { Send, StopCircle } from '@/components/icons';
import { AgentPromptField } from '@/components/terminal/AgentPromptField';
import { AttachmentChip } from '@/components/ui/attachment-chip';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { pathsForFiles, pathsToChips } from '@/lib/terminal/pasteFiles';
import { cn } from '@/lib/utils';
import { useAgentChatStore } from '@/stores/agentChatStore';
import { ChatRunPicker } from './ChatRunPicker';
import type { ChatTheme } from './chatThemes';
import { typeIntoCli } from './typeIntoCli';

const NO_ATTACHMENTS: string[] = [];

/** Gemini and Qwen read a file into the prompt from an `@path` mention. */
const AT_MENTION_CLIS = new Set(['gemini-cli', 'qwen-cli']);

/**
 * The attached images as the CLI wants them in the prompt. Claude Code and Codex attach an image
 * given its path, the same as a screenshot pasted into their terminal.
 */
function attachmentText(cliId: string, paths: string[]): string {
  if (AT_MENTION_CLIS.has(cliId)) {
    return paths.map((path) => `@${path.replace(/ /g, '\\ ')}`).join(' ');
  }
  return pathsToChips(paths, undefined)
    .map((chip) => chip.realText)
    .join(' ');
}

export interface ChatComposerProps {
  sessionId: string;
  cliId: string;
  theme: ChatTheme;
  working: boolean;
  /** The agent is asking the user something, so a typed command would answer it. */
  needsInput?: boolean;
  /** What the agent runs on now, for the model and effort picker. */
  runInfo?: AgentRunInfo;
  /** What to show in the picker when the agent reports no model. */
  runLabel?: string | null;
}

/**
 * The chat view's message box. It is the same box as the SSH and Remote Desktop prompts, so it
 * has dictation, Persian, translation to English and an AI rewrite. A message is pasted into the
 * CLI running underneath and submitted, exactly as if it had been typed there, which also means
 * one sent while the agent works is queued by the CLI the way it would be in the terminal.
 * A pasted screenshot is saved as a file and goes along as its path.
 */
export const ChatComposer = forwardRef<HTMLTextAreaElement, ChatComposerProps>(
  function ChatComposer(
    { sessionId, cliId, theme, working, needsInput = false, runInfo, runLabel = null },
    ref,
  ) {
    const draft = useAgentChatStore((s) => s.drafts[sessionId] ?? '');
    const setDraft = useAgentChatStore((s) => s.setDraft);
    const attachments = useAgentChatStore((s) => s.attachments[sessionId] ?? NO_ATTACHMENTS);
    const setAttachments = useAgentChatStore((s) => s.setAttachments);
    const addPending = useAgentChatStore((s) => s.addPending);
    const [note, setNote] = useState<string | null>(null);

    function attach(paths: string[]): void {
      if (paths.length === 0) return;
      const current = useAgentChatStore.getState().attachments[sessionId] ?? [];
      setAttachments(sessionId, [...current, ...paths.filter((path) => !current.includes(path))]);
      setNote(null);
    }

    function onPaste(event: React.ClipboardEvent): void {
      // Text pastes as text; only a paste with no text in it is an image or a copied file.
      if (event.clipboardData.getData('text/plain')) return;
      event.preventDefault();
      const files = Array.from(event.clipboardData.files ?? []);
      const paths =
        files.length > 0
          ? pathsForFiles(files)
          : // Chromium hands a textarea nothing for a screenshot; the main process can see it.
            window.runova.terminalClipboard
              .read()
              .then((content) => (content?.kind === 'files' ? content.paths : []));
      void paths.then(attach).catch(() => setNote("That image couldn't be attached."));
    }

    function send(): void {
      const text = draft.trim();
      if (!text && attachments.length === 0) return;
      const message = [attachments.length > 0 ? attachmentText(cliId, attachments) : '', text]
        .filter(Boolean)
        .join(' ');
      if (!typeIntoCli(sessionId, message)) {
        setNote(`${theme.name} isn't ready for a message yet. Try again in a moment.`);
        return;
      }
      addPending(sessionId, {
        key: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        images: attachments.length,
      });
      setDraft(sessionId, '');
      setAttachments(sessionId, []);
      setNote(null);
    }

    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-4" onPasteCapture={onPaste}>
        {note ? (
          <p role="status" className="px-2 pb-1.5 text-[11px] text-muted-foreground">
            {note}
          </p>
        ) : null}
        {attachments.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto px-2 pb-2">
            {attachments.map((path) => (
              <AttachmentChip
                key={path}
                path={path}
                onRemove={() =>
                  setAttachments(
                    sessionId,
                    attachments.filter((other) => other !== path),
                  )
                }
              />
            ))}
          </div>
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
          placeholder={working ? `Queue a message for ${theme.name}…` : `Message ${theme.name}…`}
          onSubmit={send}
          minHeight={44}
          maxHeight={200}
          className="rounded-[22px] bg-background/80 shadow-sm backdrop-blur"
          textClassName="text-sm"
          trailing={
            <div className="flex items-center gap-1">
              <ChatRunPicker
                sessionId={sessionId}
                cliId={cliId}
                theme={theme}
                runInfo={runInfo}
                fallbackLabel={runLabel}
                blockedReason={
                  working
                    ? `${theme.name} is working. Switch once it's done.`
                    : needsInput
                      ? `Answer ${theme.name} first.`
                      : null
                }
                onNotReady={() =>
                  setNote(`${theme.name} isn't ready for a command yet. Try again in a moment.`)
                }
              />
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
                disabled={!draft.trim() && attachments.length === 0}
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
