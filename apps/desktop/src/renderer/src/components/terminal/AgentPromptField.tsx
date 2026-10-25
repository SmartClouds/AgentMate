import type { AgentInstructionPurpose, AgentInstructionTarget } from '@agentmat/core';
import { useQuery } from '@tanstack/react-query';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Languages, Sparkles, Spinner, Undo } from '@/components/icons';
import {
  cancelBusyMics,
  SpeechLanguageChip,
  useSpeechSettings,
  VoiceRecordButton,
  VoiceRecordingStrip,
} from '@/components/promptBuilder/VoiceControls';
import { Button } from '@/components/ui/button';
import { FIELD_SURFACE } from '@/components/ui/input';
import { MULTILINE_FIELD_RADIUS, Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { queryKeys } from '@/lib/queryKeys';
import { containsPersian } from '@/lib/rtl';
import { cn } from '@/lib/utils';
import { commandForEvent, useShortcutLabel, useShortcutStore } from '@/stores/shortcutStore';
import { useComposerAssist } from './useComposerAssist';

/** The count shows once the text is this close to the cap, so a short note stays uncluttered. */
const COUNT_FROM_SHARE = 0.8;

export interface AgentPromptFieldProps {
  value: string;
  onChange: (value: string) => void;
  purpose: AgentInstructionPurpose;
  target: AgentInstructionTarget;
  /** The AI's question, when the text answers one. "Write it for me" answers it. */
  question?: string;
  ariaLabel: string;
  placeholder: string;
  maxLength?: number;
  /** Enter sends (a chat box), or Ctrl/Cmd+Enter does and Enter starts a new line (a form). */
  submitOn?: 'enter' | 'mod-enter';
  onSubmit: () => void;
  /** Escape, once nothing is left running in the box to cancel. */
  onEscape?: () => void;
  /** Set while the caller sends, so the text cannot change under it. */
  readOnly?: boolean;
  autoFocus?: boolean;
  /** The text box's height before it grows, and the most it grows to before it scrolls. */
  minHeight?: number;
  maxHeight?: number;
  /** What sits at the end of the toolbar, usually Send. */
  trailing?: React.ReactNode;
  className?: string;
}

const JOB_LABELS = { translate: 'Translating…', rewrite: 'Writing…' } as const;

/**
 * The box for anything the user tells an AI task: the task itself, a message mid-run, or an answer
 * to its question. Like Build Prompt it takes Persian, dictation, a translation to English, and an
 * AI rewrite of a rough note, and each of those can be undone or cancelled. The text box grows
 * with the text, and the toolbar under it keeps the tools and the caller's Send together.
 */
export const AgentPromptField = forwardRef<HTMLTextAreaElement, AgentPromptFieldProps>(
  function AgentPromptField(
    {
      value,
      onChange,
      purpose,
      target,
      question,
      ariaLabel,
      placeholder,
      maxLength,
      submitOn = 'enter',
      onSubmit,
      onEscape,
      readOnly = false,
      autoFocus = false,
      minHeight = 36,
      maxHeight = 112,
      trailing,
      className,
    },
    forwardedRef,
  ) {
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(forwardedRef, () => fieldRef.current as HTMLTextAreaElement);

    const settingsQuery = useQuery({
      queryKey: queryKeys.settings,
      queryFn: () => window.agentmat.settings.get(),
      meta: { silentLoading: true },
    });
    const assist = useComposerAssist({ value, onChange, purpose, target, question });
    const overrides = useShortcutStore((s) => s.overrides);
    const translateKey = useShortcutLabel('prompt.translate');
    const rewriteKey = useShortcutLabel('prompt.generate');

    // Dictation lands after whatever is typed by then, which the callback reads through a ref.
    const valueRef = useRef(value);
    valueRef.current = value;
    const {
      language: speechLanguage,
      model: speechModel,
      save: saveVoiceSettings,
    } = useSpeechSettings(settingsQuery.data);
    const voice = useVoiceInput({
      language: speechLanguage,
      onText: (text) => {
        const existing = valueRef.current.trim();
        const next = existing ? `${existing} ${text}` : text;
        onChange(maxLength ? next.slice(0, maxLength) : next);
      },
    });
    const voiceRef = useRef(voice);
    voiceRef.current = voice;

    useEffect(() => {
      if (voice.error) toast.error(voice.error);
    }, [voice.error]);

    // A box that goes away (the task moved on, the dialog closed) never leaves the mic live.
    useEffect(() => () => void cancelBusyMics([voiceRef.current]), []);

    // Grow with the text, like a chat box, up to a few lines.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text
    useLayoutEffect(() => {
      const field = fieldRef.current;
      if (!field) return;
      field.style.height = 'auto';
      if (field.scrollHeight > 0) {
        // scrollHeight leaves out the border, but the height is set on the border box, so
        // without it the box comes up a few pixels short and shows a scrollbar.
        const needed = field.scrollHeight + (field.offsetHeight - field.clientHeight);
        field.style.height = `${Math.min(Math.max(needed, minHeight), maxHeight)}px`;
        field.style.overflowY = needed > maxHeight ? 'auto' : 'hidden';
      } else {
        field.style.height = '';
      }
    }, [value, minHeight, maxHeight]);

    const busy = assist.busy;
    const locked = readOnly || busy !== null;
    const hasText = value.trim().length > 0;
    const persian = containsPersian(value);
    const recording = voice.status === 'recording';
    const showCount = maxLength !== undefined && value.length >= maxLength * COUNT_FROM_SHARE;

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
      if (e.key === 'Escape') {
        // What runs inside the box is cancelled first, so Escape never closes it mid-job.
        if (assist.cancel() || cancelBusyMics([voice])) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (onEscape) {
          e.stopPropagation();
          onEscape();
        }
        return;
      }
      // Enter while an input method is composing picks a candidate rather than sending.
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        const mod = e.ctrlKey || e.metaKey;
        const sends = submitOn === 'enter' ? !e.shiftKey && !mod : mod;
        if (sends) {
          e.preventDefault();
          if (!locked) onSubmit();
          return;
        }
        if (submitOn === 'enter' && mod) return;
      }
      if (e.key === 'Enter') return;
      const command = commandForEvent(e, overrides, true, 'prompt');
      if (command === 'prompt.translate' && persian) {
        e.preventDefault();
        void assist.translate();
      } else if (command === 'prompt.generate') {
        e.preventDefault();
        void assist.rewrite();
      }
    }

    return (
      <div
        className={cn(
          'flex flex-col',
          FIELD_SURFACE,
          MULTILINE_FIELD_RADIUS,
          'focus-within:ring-1 focus-within:ring-ring',
          className,
        )}
      >
        <div className={cn('rounded-t-[inherit]', busy && 'shimmer-sweep')}>
          <Textarea
            ref={fieldRef}
            variant="bare"
            autoFocus={autoFocus}
            rows={1}
            value={value}
            readOnly={locked}
            maxLength={maxLength}
            aria-label={ariaLabel}
            aria-busy={busy !== null}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="resize-none px-3.5 pb-1 pt-2 text-xs leading-5"
            style={{ minHeight, maxHeight }}
          />
        </div>

        <div className="flex min-h-9 flex-wrap items-center gap-1 px-1.5 pb-1.5">
          {busy ? (
            <div
              role="status"
              className="flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground"
            >
              <Spinner className="h-3 w-3 animate-spin" />
              {JOB_LABELS[busy]}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  assist.cancel();
                  fieldRef.current?.focus();
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <>
              {voice.supported && (
                <>
                  <VoiceRecordButton
                    voice={voice}
                    idleText="Dictate"
                    idleLabel="Dictate instead of typing"
                    blockedReason={locked ? 'Wait for the text to finish first' : null}
                    iconOnly
                    className="h-7"
                  />
                  {recording ? (
                    <VoiceRecordingStrip voice={voice} className="h-7" />
                  ) : (
                    <SpeechLanguageChip
                      language={speechLanguage}
                      modelKey={speechModel}
                      disabled={voice.status !== 'idle' || saveVoiceSettings.isPending}
                      onLanguageChange={(code) =>
                        saveVoiceSettings.mutate({ speechLanguage: code })
                      }
                      onModelChange={(key) => saveVoiceSettings.mutate({ speechModel: key })}
                    />
                  )}
                </>
              )}
              {!recording && (
                <>
                  {persian && (
                    <SimpleTooltip
                      label={
                        translateKey
                          ? `Translate to English (${translateKey})`
                          : 'Translate to English'
                      }
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={readOnly}
                        aria-label="Translate to English"
                        className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => void assist.translate()}
                      >
                        <Languages className="h-3.5 w-3.5" />
                        English
                      </Button>
                    </SimpleTooltip>
                  )}
                  <SimpleTooltip
                    label={
                      hasText
                        ? `The AI turns your note into a clear instruction${rewriteKey ? ` (${rewriteKey})` : ''}`
                        : 'Type or dictate a rough note first'
                    }
                    wrapTrigger={!hasText || readOnly}
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={!hasText || readOnly}
                      aria-label="Write it for me"
                      className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => void assist.rewrite()}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Write it for me
                    </Button>
                  </SimpleTooltip>
                  {assist.canUndo && (
                    <SimpleTooltip label="Put back what you wrote">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label="Undo"
                        className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          assist.undo();
                          fieldRef.current?.focus();
                        }}
                      >
                        <Undo className="h-3 w-3" />
                        Undo
                      </Button>
                    </SimpleTooltip>
                  )}
                </>
              )}
            </>
          )}
          <span className="flex-1" />
          {showCount && (
            <span className="px-1 text-[10px] tabular-nums text-muted-foreground">
              {value.length}/{maxLength}
            </span>
          )}
          {trailing}
        </div>
      </div>
    );
  },
);
