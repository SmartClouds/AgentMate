import {
  DEFAULT_WHISPER_MODEL,
  resolveSpeechLanguage,
  SPEECH_LANGUAGES,
  speechModelTooSmallFor,
  WHISPER_MODELS,
} from '@agentmat/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, Microphone, Spinner, StopCircle, TriangleAlert, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import type { useVoiceInput } from '@/hooks/useVoiceInput';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/**
 * The voice controls the Build Prompt dialog and the Prompt Builder page share: a microphone
 * button with a clock and a way out, and the chip that picks the language Dictate listens for.
 */

type VoiceInput = ReturnType<typeof useVoiceInput>;

export const OTHER_MIC_BUSY = 'Finish the other recording first';
export const SPEAK_PROMPT_LABEL =
  'Speak in English. Your words become the prompt as they are, with nothing generated or translated.';

export function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Throws away whatever a mic is doing, recording or transcribing. Returns true when there was
 * something to throw away, so Escape can be kept from also closing what the mic sits in.
 */
export function cancelBusyMics(mics: VoiceInput[]): boolean {
  let cancelled = false;
  for (const mic of mics) {
    if (mic.status === 'recording' || mic.status === 'transcribing') {
      mic.cancel();
      cancelled = true;
    }
  }
  return cancelled;
}

/** The spoken language and model from settings, and a way to change either on the spot. */
export function useSpeechSettings(
  settings: { speechLanguage?: string; speechModel?: string } | undefined,
) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: { speechLanguage?: string; speechModel?: string }) =>
      window.agentmat.settings.update(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.settings, next);
    },
    onError: () => toast.error('Could not save the voice input setting.'),
  });
  return {
    language: resolveSpeechLanguage(settings?.speechLanguage, navigator.language),
    model: settings?.speechModel ?? DEFAULT_WHISPER_MODEL,
    save,
  };
}

/**
 * One microphone button: idle, starting, recording with a running clock, then transcribing.
 * Next to it while recording or transcribing sits a button that throws the work away, so a slow
 * transcription never leaves the user stuck waiting on it.
 */
export function VoiceRecordButton({
  voice,
  idleText,
  idleLabel,
  blockedReason,
  iconOnly = false,
  className,
}: {
  voice: VoiceInput;
  idleText: string;
  idleLabel: string;
  /** Why the button cannot start a recording right now, or null when it can. */
  blockedReason: string | null;
  /**
   * Leaves out the words next to the microphone, for headers that share a row with other
   * controls. The recording clock and a download percentage still show, since they carry
   * information the icon cannot. The name for screen readers and the tooltip stay as they are.
   */
  iconOnly?: boolean;
  className?: string;
}): React.JSX.Element {
  const busy = voice.status === 'requesting' || voice.status === 'transcribing';
  const recording = voice.status === 'recording';
  const transcribing = voice.status === 'transcribing';
  const blocked = voice.status === 'idle' && blockedReason !== null;
  const label = recording
    ? 'Stop and transcribe'
    : transcribing
      ? voice.downloadPercent !== null
        ? `Downloading speech model… ${voice.downloadPercent}%`
        : 'Transcribing…'
      : voice.status === 'requesting'
        ? 'Starting microphone…'
        : idleLabel;
  const discardLabel = recording ? 'Discard recording' : 'Cancel transcription';
  const text = recording
    ? `Stop ${formatElapsed(voice.elapsedSeconds)}`
    : transcribing
      ? voice.downloadPercent !== null
        ? `${voice.downloadPercent}%`
        : iconOnly
          ? null
          : 'Transcribing…'
      : iconOnly
        ? null
        : idleText;

  return (
    <div className="flex items-center gap-1">
      <SimpleTooltip label={blocked ? blockedReason : label} wrapTrigger={busy || blocked}>
        <Button
          type="button"
          variant={recording ? 'destructive' : 'ghost'}
          size="sm"
          className={cn('gap-1.5 px-2.5', text === null && 'w-8 px-0', className)}
          onClick={voice.toggle}
          disabled={busy || blocked}
          aria-label={recording ? label : voice.status === 'idle' ? idleText : label}
        >
          {busy ? (
            <Spinner className="animate-spin" />
          ) : recording ? (
            <StopCircle />
          ) : (
            <Microphone />
          )}
          {text !== null && <span className="tabular-nums">{text}</span>}
        </Button>
      </SimpleTooltip>
      {(recording || transcribing) && (
        <SimpleTooltip label={`${discardLabel} (Esc)`}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={voice.cancel}
            aria-label={discardLabel}
          >
            <X />
          </Button>
        </SimpleTooltip>
      )}
    </div>
  );
}

/**
 * The language Dictate listens for, switchable on the spot. Whisper has to be told the language
 * up front, and the smaller models garble Persian, so the chip also says when the chosen model
 * is too small and offers the one that works.
 */
export function SpeechLanguageChip({
  language,
  modelKey,
  disabled,
  onLanguageChange,
  onModelChange,
}: {
  language: string;
  modelKey: string;
  disabled: boolean;
  onLanguageChange: (code: string) => void;
  onModelChange: (key: string) => void;
}): React.JSX.Element {
  const current = SPEECH_LANGUAGES.find((lang) => lang.code === language);
  const tooSmall = speechModelTooSmallFor(modelKey, language);
  const better = WHISPER_MODELS.find((m) => m.key === current?.recommendedModel);
  const name = current?.label ?? language;

  return (
    <DropdownMenu>
      <SimpleTooltip
        label={
          tooSmall
            ? `The current speech model often gets ${name} wrong. Click to switch to a better one.`
            : `Dictate listens for ${name}. Click to change.`
        }
        wrapTrigger={disabled}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 gap-1 px-2 text-xs font-semibold uppercase tracking-wide',
              tooSmall && 'text-amber-600 dark:text-amber-400',
            )}
            disabled={disabled}
            aria-label={`Dictation language: ${name}`}
          >
            {tooSmall && <TriangleAlert className="h-3.5 w-3.5" />}
            {language}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Dictate in</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={language} onValueChange={onLanguageChange}>
          {SPEECH_LANGUAGES.map((lang) => (
            <DropdownMenuRadioItem key={lang.code} value={lang.code}>
              {lang.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {tooSmall && better ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onModelChange(better.key)}>
              <TriangleAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <span className="min-w-0 flex-1">
                <span className="block">Use a model that understands {name}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">
                  {better.label}. Downloads once, the next time you dictate.
                </span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
