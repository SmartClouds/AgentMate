import {
  DEFAULT_WHISPER_MODEL,
  resolveSpeechLanguage,
  SPEECH_LANGUAGES,
  speechModelTooSmallFor,
  WHISPER_MODELS,
} from '@agentmat/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  ChevronDown,
  Microphone,
  Spinner,
  StopCircle,
  Trash2,
  TriangleAlert,
  X,
} from '@/components/icons';
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
 * button, the strip that shows a recording (clock, level bars, discard), and the chip that picks
 * the language Dictate listens for.
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
 * One microphone button: idle, starting, recording, then transcribing. While recording it turns
 * into the stop button right where it was clicked and stays the same size, so nothing around it
 * moves. The clock, the level bars and the way to throw the recording away live in a
 * VoiceRecordingStrip, which the caller shows in whatever room its row has. Next to the button
 * while transcribing sits a button that drops the work, so a slow transcription never leaves the
 * user stuck waiting on it.
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
   * controls. A download percentage still shows, since it carries information the icon cannot.
   * The name for screen readers and the tooltip stay as they are.
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
  const text = recording
    ? iconOnly
      ? null
      : 'Stop'
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
      {transcribing && (
        <SimpleTooltip label="Cancel transcription (Esc)">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={voice.cancel}
            aria-label="Cancel transcription"
          >
            <X />
          </Button>
        </SimpleTooltip>
      )}
    </div>
  );
}

// One bar per sample, newest on the right. At this size and gap the row is about 160px wide,
// and a narrower strip clips the oldest bars rather than squeezing the newest. They fade out
// toward the left edge, so a half-clipped bar never shows as a stray line.
const LEVEL_BAR_COUNT = 32;
const LEVEL_SAMPLE_MS = 55;
// A silent bar is a short dot instead of nothing, so the row reads as "listening" before anyone
// speaks. This is the share of the full height it keeps.
const LEVEL_BAR_REST = 0.16;

/**
 * Live bars for the microphone, scrolling left like a voice message being recorded. The level is
 * read from an animation frame and written straight to the bars, so the dialog that owns the
 * mic never re-renders for it.
 */
function VoiceLevelBars({
  getLevel,
  className,
}: {
  getLevel: () => number;
  className?: string;
}): React.JSX.Element {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const levels = new Array<number>(LEVEL_BAR_COUNT).fill(0);
    const paint = () => {
      bars.current.forEach((bar, i) => {
        if (bar)
          bar.style.transform = `scaleY(${LEVEL_BAR_REST + (1 - LEVEL_BAR_REST) * levels[i]!})`;
      });
    };
    let lastSample = 0;
    let frame = 0;
    const tick = (now: number) => {
      if (now - lastSample >= LEVEL_SAMPLE_MS) {
        lastSample = now;
        levels.shift();
        levels.push(getLevel());
        paint();
      }
      frame = requestAnimationFrame(tick);
    };
    paint();
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getLevel]);

  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex h-5 min-w-0 items-center justify-end gap-[2px] overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_20px)]',
        className,
      )}
    >
      {Array.from({ length: LEVEL_BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="h-full w-[3px] shrink-0 rounded-full bg-destructive/80 transition-transform duration-100 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${LEVEL_BAR_REST})` }}
        />
      ))}
    </div>
  );
}

/**
 * What a recording shows for itself: a way to throw it away, a clock, and level bars that move
 * with the voice. It takes the place of whatever shares the row, such as the Size chip, so
 * starting a recording does not push the text box below down. Stopping stays on the mic button.
 */
export function VoiceRecordingStrip({
  voice,
  className,
}: {
  voice: VoiceInput;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Recording"
      className={cn(
        'flex h-8 min-w-[9.5rem] max-w-[17rem] flex-1 basis-0 items-center gap-1.5 rounded-full bg-destructive/10 pl-1 pr-3 ring-1 ring-destructive/20 duration-150 animate-in fade-in-0 motion-reduce:animate-none',
        className,
      )}
    >
      <SimpleTooltip label="Discard recording (Esc)">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
          onClick={voice.cancel}
          aria-label="Discard recording"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </SimpleTooltip>
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full bg-destructive motion-safe:animate-pulse"
      />
      <span role="timer" className="shrink-0 text-xs font-medium tabular-nums">
        {formatElapsed(voice.elapsedSeconds)}
      </span>
      <VoiceLevelBars getLevel={voice.getLevel} className="flex-1" />
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
