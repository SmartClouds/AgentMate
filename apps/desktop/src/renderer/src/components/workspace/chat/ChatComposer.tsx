import { forwardRef, useEffect, useState } from 'react';
import { Send, StopCircle, X } from '@/components/icons';
import { AgentPromptField } from '@/components/terminal/AgentPromptField';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { pathsForFiles, pathsToChips } from '@/lib/terminal/pasteFiles';
import { terminalRuntime } from '@/lib/terminal/terminalRuntime';
import { cn } from '@/lib/utils';
import { useAgentChatStore } from '@/stores/agentChatStore';
import type { ChatTheme } from './chatThemes';

/** Gives the CLI a moment to take the paste in before Enter submits it, as Relay does. */
const SUBMIT_DELAY_MS = 150;

const NO_ATTACHMENTS: string[] = [];

/** Gemini and Qwen read a file into the prompt from an `@path` mention. */
const AT_MENTION_CLIS = new Set(['gemini-cli', 'qwen-cli']);

function fileLabel(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

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

function AttachmentChip({
  path,
  onRemove,
}: {
  path: string;
  onRemove: () => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState<string | null>(null);
  const label = fileLabel(path);
  useEffect(() => {
    let live = true;
    void window.runova.terminalClipboard
      .previewImage(path, false)
      .then((url) => {
        if (live) setPreview(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <div className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-border bg-muted">
      {preview ? (
        <img src={preview} alt={label} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center p-1 text-center text-[9px] text-muted-foreground">
          {label}
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

export interface ChatComposerProps {
  sessionId: string;
  cliId: string;
  theme: ChatTheme;
  working: boolean;
}

/**
 * The chat view's message box. It is the same box as the SSH and Remote Desktop prompts, so it
 * has dictation, Persian, translation to English and an AI rewrite. A message is pasted into the
 * CLI running underneath and submitted, exactly as if it had been typed there, which also means
 * one sent while the agent works is queued by the CLI the way it would be in the terminal.
 * A pasted screenshot is saved as a file and goes along as its path.
 */
export const ChatComposer = forwardRef<HTMLTextAreaElement, ChatComposerProps>(
  function ChatComposer({ sessionId, cliId, theme, working }, ref) {
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
      if (!terminalRuntime.insertText(sessionId, message)) {
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
      setTimeout(() => void window.runova.terminal.write(sessionId, '\r'), SUBMIT_DELAY_MS);
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
