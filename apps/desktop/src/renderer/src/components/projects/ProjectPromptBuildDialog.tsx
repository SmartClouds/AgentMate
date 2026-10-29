import type { Project, PromptType, TargetAI } from '@runova/core';
import {
  cliIdForTargetAI,
  EFFORT_LABELS,
  getCliDefinition,
  PROMPT_TYPES,
  TARGET_AIS,
} from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CliLogo, cliOptionIcon } from '@/components/cliLogos';
import { GrammarTextarea } from '@/components/grammar/GrammarTextarea';
import {
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  History,
  Languages,
  ListTodo,
  Pin,
  Save,
  Sparkles,
  Spinner,
  TerminalSquare,
  Trash2,
  WindowMaximize,
  WindowRestore,
} from '@/components/icons';
import { ProjectIcon } from '@/components/projects/ProjectIcon';
import {
  type ComposerValues,
  PromptComposerDialog,
} from '@/components/projects/prompts/PromptComposerDialog';
import {
  RunRecommendationChip,
  useRunRecommendation,
} from '@/components/promptBuilder/RunRecommendation';
import {
  cancelBusyMics,
  OTHER_MIC_BUSY,
  SPEAK_PROMPT_LABEL,
  SpeechLanguageChip,
  useSpeechSettings,
  VoiceRecordButton,
  VoiceRecordingStrip,
} from '@/components/promptBuilder/VoiceControls';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useAgentChoices } from '@/components/workspace/useAgentChoices';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { queryKeys } from '@/lib/queryKeys';
import { containsPersian } from '@/lib/rtl';
import { cn } from '@/lib/utils';
import { launchPromptTab, projectCliId } from '@/lib/workspace/launch';
import { projectPromptJobKey, usePromptJobsStore } from '@/stores/promptJobsStore';
import { useRelayPlanDialogStore } from '@/stores/relayPlanDialogStore';
import {
  commandForEvent,
  useShortcutLabel,
  useShortcutLabelList,
  useShortcutStore,
} from '@/stores/shortcutStore';
import { useProjectPromptBuilder } from './useProjectPromptBuilder';

export interface ProjectPromptBuildDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  /** The project's icon, so the dialog wears the same avatar as its card. */
  iconDataUrl?: string | null;
  iconBgColor?: string | null;
  iconColor?: string | null;
  /** The workspace pane an "Open in agent" launch should land in, when opened from one. */
  launchGroupId?: string | null;
  /**
   * Where "Open in agent" starts the agent, when that is not the project's own folder: a
   * worktree's workspace passes itself, so the agent works in the worktree.
   */
  launchProject?: Project | null;
}

export function ProjectPromptBuildDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  iconDataUrl = null,
  iconBgColor = null,
  iconColor = null,
  launchGroupId = null,
  launchProject = null,
}: ProjectPromptBuildDialogProps): React.JSX.Element {
  const navigate = useNavigate();
  const [isMaximized, setIsMaximized] = useState(false);
  const [isPinning, setIsPinning] = useState(false);
  const [copied, setCopied] = useState(false);
  const requestRef = useRef<HTMLTextAreaElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobKey = projectPromptJobKey(projectId);
  const setJobVisible = usePromptJobsStore((s) => s.setVisible);
  // The switch decides whether Generate and Translate size their result, so it is read first.
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    enabled: open,
  });
  const autoSize = settingsQuery.data?.promptBuilderAutoSize ?? true;
  const {
    rawInput,
    setRawInput,
    promptType,
    setPromptType,
    targetAI,
    setTargetAI,
    generated,
    generatedSource,
    setGenerated,
    setDictatedPrompt,
    isGenerating,
    isTranslating,
    handleGenerate,
    handleTranslate,
    handleCancel,
    handleCopy,
    handleClear,
    saveDraftMutation,
  } = useProjectPromptBuilder(projectId, {
    enabled: open,
    onDraftSaved: () => onOpenChange(false),
    sizeResults: autoSize,
    notifyWhenHidden: projectName,
  });

  const runRecommendation = useRunRecommendation({
    jobKey,
    generated,
    promptType,
    targetAI,
    // Neither a translation nor a spoken prompt was shaped by the prompt type.
    isTranslation: generatedSource === 'translate' || generatedSource === 'dictate',
  });
  const hasRequest = rawInput.trim().length > 0;
  const isBusy = isGenerating || isTranslating;
  const isPersian = containsPersian(rawInput);

  // Dictation lands after whatever is already typed. The transcription callback outlives the
  // render that started it, so it reads the latest request through a ref.
  const rawInputRef = useRef(rawInput);
  rawInputRef.current = rawInput;
  const {
    language: speechLanguage,
    model: speechModel,
    save: saveVoiceSettings,
  } = useSpeechSettings(settingsQuery.data);
  const voice = useVoiceInput({
    language: speechLanguage,
    onText: (text) => {
      const existing = rawInputRef.current.trim();
      setRawInput(existing ? `${existing} ${text}` : text);
    },
  });
  // Speak prompt skips Generate and Translate, so it is always heard as English: the words land
  // in the prompt exactly as spoken, never translated.
  const generatedRef = useRef(generated);
  generatedRef.current = generated;
  const promptVoice = useVoiceInput({
    language: 'en',
    onText: (text) => {
      const existing = generatedRef.current.trim();
      setDictatedPrompt(existing ? `${existing} ${text}` : text);
    },
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const promptVoiceRef = useRef(promptVoice);
  promptVoiceRef.current = promptVoice;
  const promptTranscribing = promptVoice.status === 'transcribing';

  useEffect(() => {
    if (voice.error) toast.error(voice.error);
  }, [voice.error]);
  useEffect(() => {
    if (promptVoice.error) toast.error(promptVoice.error);
  }, [promptVoice.error]);

  const queryClient = useQueryClient();
  const overrides = useShortcutStore((s) => s.overrides);
  const generateKeys = useShortcutLabelList('prompt.generate');
  const generateKey = useShortcutLabel('prompt.generate');
  const translateKey = useShortcutLabel('prompt.translate');
  const copyKey = useShortcutLabel('prompt.copy');

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  // Closing doesn't stop Generate, Translate or sizing; they finish in the background and
  // the jobs store uses this to decide whether to toast that a result is waiting.
  useEffect(() => {
    setJobVisible(jobKey, open);
    return () => setJobVisible(jobKey, false);
  }, [jobKey, open, setJobVisible]);

  useEffect(() => {
    if (!open) {
      setIsMaximized(false);
      // Never leave the microphone live behind a closed dialog. Stopping still transcribes,
      // and the text is kept with the rest of this project's draft request.
      if (voiceRef.current.status === 'recording') voiceRef.current.toggle();
      if (promptVoiceRef.current.status === 'recording') promptVoiceRef.current.toggle();
    }
  }, [open]);

  async function handlePinToDesktop(): Promise<void> {
    setIsPinning(true);
    try {
      await window.runova.promptBuildWidget.openWidget(projectId, projectName);
      onOpenChange(false);
      toast.success('Build Prompt added to your desktop.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the widget to your desktop.');
    } finally {
      setIsPinning(false);
    }
  }

  async function onCopy(): Promise<void> {
    await handleCopy();
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1600);
  }

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
    enabled: open,
  });
  const project = projectsQuery.data?.find((p) => p.id === projectId) ?? null;
  const agentChoices = useAgentChoices(project);
  const [launching, setLaunching] = useState(false);

  const defaultCliId = project ? projectCliId(project) : null;
  const defaultCli = defaultCliId ? getCliDefinition(defaultCliId) : undefined;
  // A fresh sizing names a model and effort for the target's own CLI.
  const suggestion =
    runRecommendation.recommendation &&
    runRecommendation.choice &&
    !runRecommendation.isStale &&
    runRecommendation.recommendation.profile.cliId &&
    runRecommendation.args.length > 0
      ? {
          cliId: runRecommendation.recommendation.profile.cliId,
          args: runRecommendation.args,
          label: [
            runRecommendation.choice.model.label,
            runRecommendation.choice.effort ? EFFORT_LABELS[runRecommendation.choice.effort] : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }
      : null;
  const suggestionCli = suggestion ? getCliDefinition(suggestion.cliId) : undefined;

  const [scheduling, setScheduling] = useState(false);
  const scheduleMutation = useMutation({
    mutationFn: (values: ComposerValues) =>
      window.runova.scheduledTasks.createMany({
        projectId,
        tasks: [
          {
            rawInput: rawInput.trim() || values.text,
            promptType,
            targetAI,
            content: values.text,
            runAt: values.runAt,
            runMode: values.runMode,
            cliId: values.run.cliId,
            model: values.run.model,
            effort: values.run.effort,
          },
        ],
      }),
    onSuccess: () => {
      toast.success('Prompt scheduled. Find it under the project’s Prompts section.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks(projectId) });
      setScheduling(false);
      onOpenChange(false);
    },
    onError: () => toast.error('Could not schedule the prompt.'),
  });

  async function openInAgent(launch: {
    cliId: string;
    runArgs?: string[];
    runLabel?: string;
  }): Promise<void> {
    if (!project || !generated.trim()) return;
    setLaunching(true);
    try {
      const target = launchProject ?? project;
      const tabId = launchPromptTab(
        target,
        { ...launch, prompt: generated },
        launchGroupId ?? undefined,
      );
      if (!tabId) return;
      onOpenChange(false);
      navigate(`/workspace/${target.id}`);
      const name = getCliDefinition(launch.cliId)?.name ?? 'the agent';
      toast.success(`Starting ${name}`, {
        description: 'The prompt goes in as soon as it is ready. Press Enter in the tab to run it.',
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the agent.');
    } finally {
      setLaunching(false);
    }
  }

  function goToHistory(): void {
    onOpenChange(false);
    navigate(`/projects/${projectId}?tab=prompts`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0 transition-[width,height,max-width,max-height]',
          isMaximized
            ? 'h-[92vh] max-h-[92vh] w-[95vw] max-w-[95vw]'
            : 'h-[min(38rem,82vh)] max-h-[82vh] w-[min(60rem,94vw)] max-w-[60rem]',
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestRef.current?.focus();
        }}
        // These run before the app-wide shortcuts, which stand down for
        // anything handled here. That is what lets Ctrl+T translate in this
        // dialog while it toggles the terminal everywhere else.
        onKeyDown={(event) => {
          const command = commandForEvent(event.nativeEvent, overrides, false, 'prompt');
          if (command === 'prompt.generate') {
            event.preventDefault();
            if (hasRequest && !isBusy) void handleGenerate();
            return;
          }
          if (command === 'prompt.translate') {
            event.preventDefault();
            if (hasRequest && !isBusy) void handleTranslate();
            return;
          }
          if (command === 'prompt.copy') {
            if (hasTextSelection() || !generated || isBusy) return;
            event.preventDefault();
            void onCopy();
          }
        }}
        // Escape while a mic is recording or transcribing throws that away instead of closing
        // the dialog.
        onEscapeKeyDown={(event) => {
          if (cancelBusyMics([voice, promptVoice])) event.preventDefault();
        }}
      >
        {!isMaximized && (
          <SimpleTooltip label="Keep this on the desktop">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void handlePinToDesktop()}
              disabled={isPinning}
              className="absolute right-[5.25rem] top-3 z-10"
            >
              <Pin />
              <span className="sr-only">Add to desktop</span>
            </Button>
          </SimpleTooltip>
        )}

        <SimpleTooltip label={isMaximized ? 'Restore size' : 'Maximize'}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setIsMaximized((v) => !v)}
            className="absolute right-12 top-3 z-10"
          >
            {isMaximized ? <WindowRestore /> : <WindowMaximize />}
            <span className="sr-only">{isMaximized ? 'Restore size' : 'Maximize'}</span>
          </Button>
        </SimpleTooltip>

        <DialogHeader className="border-b border-border/70 px-5 py-4 pr-28 text-left">
          <div className="flex items-center gap-3">
            <ProjectIcon
              iconDataUrl={iconDataUrl}
              bgColor={iconBgColor}
              iconColor={iconColor}
              className="h-9 w-9"
            />
            <div className="min-w-0 space-y-1">
              <DialogTitle>Build Prompt</DialogTitle>
              <DialogDescription className="truncate">
                Turn a rough request into a prompt for {projectName}.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 px-5 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <Label className="shrink-0 text-xs text-muted-foreground">Type</Label>
              <Combobox
                className="h-8 w-[11.5rem]"
                value={promptType}
                onChange={(v) => setPromptType(v as PromptType)}
                options={PROMPT_TYPES.map((type) => ({ value: type, label: type }))}
              />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Label className="shrink-0 text-xs text-muted-foreground">Target</Label>
              <Combobox
                className="h-8 w-[11.5rem]"
                value={targetAI}
                onChange={(v) => setTargetAI(v as TargetAI)}
                options={TARGET_AIS.map((ai) => ({
                  value: ai,
                  label: ai,
                  icon: cliOptionIcon(cliIdForTargetAI(ai)),
                }))}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={goToHistory}
              className="ml-auto text-muted-foreground"
            >
              <History /> History
            </Button>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
            <div className="flex min-h-0 flex-col gap-2 border-b border-border/70 p-5 md:border-b-0 md:border-r">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="prompt-build-request" className="shrink-0">
                  Your request
                </Label>
                <div className="flex items-center gap-2">
                  {/* A recording takes the counter's and the language chip's room, so the row keeps its height. */}
                  {voice.status === 'recording' ? (
                    <VoiceRecordingStrip voice={voice} />
                  ) : (
                    <>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {rawInput.length === 0 ? 'Empty' : `${rawInput.length} chars`}
                      </span>
                      {voice.supported && (
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
                  {voice.supported && (
                    <VoiceRecordButton
                      voice={voice}
                      idleText="Dictate"
                      idleLabel="Dictate your request"
                      blockedReason={promptVoice.status !== 'idle' ? OTHER_MIC_BUSY : null}
                    />
                  )}
                </div>
              </div>
              <div className="relative min-h-0 flex-1">
                <GrammarTextarea
                  id="prompt-build-request"
                  ref={requestRef}
                  containerClassName="absolute inset-0"
                  className="h-full min-h-0 w-full resize-none bg-background/60"
                  placeholder="e.g. Add a login form with email/password validation…"
                  value={rawInput}
                  onChange={(e) => setRawInput(e.target.value)}
                />
              </div>
              {isPersian && (
                <p className="text-[11px] text-muted-foreground">
                  Persian is fine. Generate writes the prompt in English.
                </p>
              )}
              <div className="flex gap-2">
                <SimpleTooltip
                  label={generateKeys ?? 'Generate prompt'}
                  wrapTrigger={!hasRequest || isBusy}
                >
                  <Button
                    className="flex-1"
                    onClick={() => void handleGenerate()}
                    disabled={!hasRequest || isBusy}
                  >
                    {isGenerating ? <Spinner className="animate-spin" /> : <Sparkles />}
                    {isGenerating ? 'Generating…' : 'Generate prompt'}
                    {!isGenerating && generateKey && (
                      <kbd className="ml-auto rounded border border-primary-foreground/25 px-1 py-px text-[10px] font-medium text-primary-foreground/80">
                        {generateKey}
                      </kbd>
                    )}
                  </Button>
                </SimpleTooltip>
                <SimpleTooltip
                  label={
                    translateKey
                      ? `Copy your request into English without generating a prompt (${translateKey})`
                      : 'Copy your request into English without generating a prompt'
                  }
                  wrapTrigger={!hasRequest || isBusy}
                >
                  <Button
                    variant="secondary"
                    onClick={() => void handleTranslate()}
                    disabled={!hasRequest || isBusy}
                  >
                    {isTranslating ? <Spinner className="animate-spin" /> : <Languages />}
                    {isTranslating ? 'Translating…' : 'Translate'}
                    {!isTranslating && translateKey && (
                      <kbd className="rounded border border-border px-1 py-px text-[10px] font-medium text-muted-foreground">
                        {translateKey}
                      </kbd>
                    )}
                  </Button>
                </SimpleTooltip>
              </div>
            </div>

            <div className="relative flex min-h-0 flex-col gap-2 p-5">
              <div className="flex items-start justify-between gap-2">
                {/* The chip stays beside the title and gives up its effort text first when the row
                    is tight. Its 9rem basis means it only wraps under the title once even the
                    model name would stop fitting, so the name is never squeezed away. While Speak
                    prompt records, the recording strip sits where the chip is, and the mic button
                    turns into the stop button without changing size, so no row grows and the text
                    box stays put. */}
                <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <Label htmlFor="prompt-build-output" className="flex h-8 shrink-0 items-center">
                    Generated prompt
                  </Label>
                  {promptVoice.status === 'recording' ? (
                    <VoiceRecordingStrip voice={promptVoice} />
                  ) : (
                    <RunRecommendationChip
                      state={runRecommendation}
                      className="max-w-fit grow basis-36"
                      sizeOnOpen={!autoSize}
                    />
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {promptVoice.supported && (
                    <VoiceRecordButton
                      voice={promptVoice}
                      idleText="Speak prompt"
                      idleLabel={SPEAK_PROMPT_LABEL}
                      iconOnly
                      blockedReason={
                        voice.status !== 'idle'
                          ? OTHER_MIC_BUSY
                          : isBusy
                            ? 'Wait for the prompt to finish'
                            : null
                      }
                    />
                  )}
                  <SimpleTooltip
                    label={copied ? 'Copied' : copyKey ? `Copy prompt (${copyKey})` : 'Copy prompt'}
                    wrapTrigger={!generated || isBusy}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={!generated || isBusy}
                      onClick={() => void onCopy()}
                      aria-label={copied ? 'Copied' : 'Copy'}
                    >
                      {copied ? <Check className="text-primary" /> : <Copy />}
                    </Button>
                  </SimpleTooltip>
                </div>
              </div>
              <div className="relative min-h-0 flex-1">
                <Textarea
                  id="prompt-build-output"
                  value={generated}
                  onChange={(e) => setGenerated(e.target.value)}
                  placeholder="Generate, translate, or speak a prompt to fill this."
                  className="absolute inset-0 min-h-0 resize-none font-mono text-sm leading-relaxed"
                  aria-busy={isBusy || promptTranscribing}
                />
                {(isBusy || promptTranscribing) && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[calc(var(--radius)+6px)] bg-background/70 backdrop-blur-[2px]">
                    <Spinner className="h-5 w-5 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">
                      {isGenerating
                        ? 'Generating prompt…'
                        : isTranslating
                          ? 'Translating…'
                          : promptVoice.downloadPercent !== null
                            ? `Downloading speech model… ${promptVoice.downloadPercent}%`
                            : 'Writing down what you said…'}
                    </p>
                    <Button
                      type="button"
                      variant="soft"
                      size="sm"
                      className="mt-1"
                      onClick={isBusy ? handleCancel : promptVoice.cancel}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="items-center border-t border-border/70 bg-muted/20 px-5 py-3 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={!rawInput && !generated}
            onClick={handleClear}
            className="text-muted-foreground"
          >
            <Trash2 /> Clear
          </Button>
          <p className="hidden text-xs text-muted-foreground xl:block">
            {[
              generateKey && `${generateKey} generate`,
              translateKey && `${translateKey} translate`,
              copyKey && `${copyKey} copy`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div className="flex items-center gap-2">
            <SimpleTooltip
              label={
                rawInput.trim() || generated.trim()
                  ? 'Break this into tasks that each fit one AI session, and run them in order'
                  : 'Describe the work first'
              }
              wrapTrigger={!rawInput.trim() && !generated.trim()}
            >
              <Button
                variant="outline"
                disabled={(!rawInput.trim() && !generated.trim()) || isBusy}
                onClick={() =>
                  useRelayPlanDialogStore.getState().show({
                    kind: 'split',
                    request: generated.trim() || rawInput.trim(),
                    projectId,
                  })
                }
              >
                <ListTodo /> Split into tasks
              </Button>
            </SimpleTooltip>
            <SimpleTooltip
              label={
                generated ? 'Park this on the project’s Overview tab' : 'Generate a prompt first'
              }
              wrapTrigger={!generated}
            >
              <Button
                variant="outline"
                disabled={!generated || saveDraftMutation.isPending}
                onClick={() => saveDraftMutation.mutate()}
              >
                {saveDraftMutation.isPending ? <Spinner className="animate-spin" /> : <Save />}
                {saveDraftMutation.isPending ? 'Saving…' : 'Save draft'}
              </Button>
            </SimpleTooltip>

            <div className="flex">
              <SimpleTooltip
                label={
                  !generated
                    ? 'Generate a prompt first'
                    : suggestion
                      ? `Open ${suggestionCli?.name ?? 'the agent'} on ${suggestion.label} in the workspace with this prompt typed in. Press Enter there to run it.`
                      : `Open ${defaultCli?.name ?? 'the agent'} in the workspace with this prompt typed in. Press Enter there to run it.`
                }
                wrapTrigger={!generated || launching}
              >
                <Button
                  className="rounded-r-none"
                  disabled={!generated || isBusy || launching || (!suggestion && !defaultCliId)}
                  onClick={() =>
                    void openInAgent(
                      suggestion
                        ? {
                            cliId: suggestion.cliId,
                            runArgs: suggestion.args,
                            runLabel: suggestion.label,
                          }
                        : { cliId: defaultCliId ?? '' },
                    )
                  }
                >
                  {launching ? <Spinner className="animate-spin" /> : <TerminalSquare />}
                  {suggestion
                    ? `Run on ${suggestion.label}`
                    : `Open in ${defaultCli?.name ?? 'agent'}`}
                </Button>
              </SimpleTooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="w-8 rounded-l-none border-l border-primary-foreground/20 px-0"
                    disabled={!generated || isBusy || launching}
                    aria-label="More ways to run this prompt"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="w-72">
                  {suggestion && suggestionCli ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        void openInAgent({
                          cliId: suggestion.cliId,
                          runArgs: suggestion.args,
                          runLabel: suggestion.label,
                        })
                      }
                    >
                      <CliLogo cliId={suggestion.cliId} className="h-4 w-4" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{suggestionCli.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          Suggested: {suggestion.label}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ) : null}
                  {defaultCli && defaultCliId ? (
                    <DropdownMenuItem onSelect={() => void openInAgent({ cliId: defaultCliId })}>
                      <CliLogo cliId={defaultCliId} className="h-4 w-4" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{defaultCli.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          Default model and effort
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ) : null}
                  {agentChoices.installed.some((c) => c.cli.id !== defaultCliId) ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Other agents</DropdownMenuLabel>
                      {agentChoices.installed
                        .filter((c) => c.cli.id !== defaultCliId)
                        .map((choice) => (
                          <DropdownMenuItem
                            key={choice.cli.id}
                            onSelect={() => void openInAgent({ cliId: choice.cli.id })}
                          >
                            <CliLogo cliId={choice.cli.id} className="h-4 w-4" />
                            {choice.cli.name}
                          </DropdownMenuItem>
                        ))}
                    </>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setScheduling(true)}>
                    <CalendarDays className="h-4 w-4" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">Add scheduled task</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        Run it later, by hand or at a set time
                      </span>
                    </span>
                  </DropdownMenuItem>
                  {!suggestion && runRecommendation.canAnalyze ? (
                    <>
                      <DropdownMenuSeparator />
                      <p className="px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">
                        Size the prompt with the chip above to get a suggested model and effort.
                      </p>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
      {scheduling ? (
        <PromptComposerDialog
          open
          title="Add scheduled task"
          description={`Save this prompt to ${projectName}'s schedule.`}
          lockKind
          initial={{
            kind: 'scheduled',
            text: generated,
            run: suggestion
              ? {
                  cliId: suggestion.cliId,
                  model: runRecommendation.choice?.model.modelArg,
                  effort: runRecommendation.choice?.effort,
                }
              : { cliId: defaultCliId ?? undefined },
          }}
          pending={scheduleMutation.isPending}
          onClose={() => setScheduling(false)}
          onSubmit={(values) => scheduleMutation.mutate(values)}
        />
      ) : null}
    </Dialog>
  );
}

/** True when the user is copying a highlighted range, so Ctrl+C should stay native. */
function hasTextSelection(): boolean {
  const el = document.activeElement;
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    el.selectionStart !== el.selectionEnd
  ) {
    return true;
  }
  return (window.getSelection()?.toString().length ?? 0) > 0;
}
