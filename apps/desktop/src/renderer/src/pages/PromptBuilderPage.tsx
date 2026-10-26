import type { PromptType, ScheduledTaskRunMode, TargetAI } from '@runova/core';
import {
  buildPromptGenerationRequest,
  CLI_REGISTRY,
  cliIdForTargetAI,
  DEFAULT_TARGET_AI,
  generatePrompt,
  isTargetAI,
  normalizeTargetAI,
  PROMPT_TYPES,
  resolvePromptTargetAI,
  TARGET_AIS,
  targetAIForProject,
} from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { type RunSettings, RunSettingsFields } from '@/components/cli/RunSettingsFields';
import { cliOptionIcon } from '@/components/cliLogos';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { GrammarTextarea } from '@/components/grammar/GrammarTextarea';
import {
  CalendarDays,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  History,
  Languages,
  ListTodo,
  Plus,
  Save,
  Search,
  Sparkles,
  Spinner,
  TerminalSquare,
  Trash2,
} from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import {
  RunRecommendationPanel,
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
import { SplitIntoTasksDialog } from '@/components/relay/SplitIntoTasksDialog';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { cliLaunchCommand } from '@/lib/openCli';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useCliStore } from '@/stores/cliStore';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { type PromptBuilderStatus, usePromptBuilderStore } from '@/stores/promptBuilderStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { PromptHistoryEntry } from '../../../shared/apiTypes';

interface ScheduleQueueItem {
  id: string;
  text: string;
  /** Value of a datetime-local input, e.g. "2026-07-19T10:00". */
  runAt: string;
}

const STATUS_OPTIONS: { value: PromptBuilderStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
];

function defaultRunAt(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

const TRANSLATE_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'fa', label: 'Persian (فارسی)' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'ar', label: 'Arabic' },
  { value: 'zh-CN', label: 'Chinese (Simplified)' },
  { value: 'ru', label: 'Russian' },
  { value: 'hi', label: 'Hindi' },
  { value: 'tr', label: 'Turkish' },
];

export default function PromptBuilderPage(): React.JSX.Element {
  const {
    rawInput,
    setRawInput,
    promptType,
    setPromptType,
    targetAI,
    setTargetAI,
    generated,
    setGenerated,
    targetLang,
    setTargetLang,
    projectId,
    setProjectId,
    status,
    setStatus,
  } = usePromptBuilderStore(
    useShallow((s) => ({
      rawInput: s.rawInput,
      setRawInput: s.setRawInput,
      promptType: s.promptType,
      setPromptType: s.setPromptType,
      targetAI: s.targetAI,
      setTargetAI: s.setTargetAI,
      generated: s.generated,
      setGenerated: s.setGenerated,
      targetLang: s.targetLang,
      setTargetLang: s.setTargetLang,
      projectId: s.projectId,
      setProjectId: s.setProjectId,
      status: s.status,
      setStatus: s.setStatus,
    })),
  );
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [scheduleQueue, setScheduleQueue] = useState<ScheduleQueueItem[]>([]);
  const [seriesRunMode, setSeriesRunMode] = useState<ScheduledTaskRunMode>('auto');
  const [seriesRun, setSeriesRun] = useState<RunSettings>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState('');

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion();
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };
  const defaultCliId = useCliStore((s) => s.defaultCliId);
  const openSession = useTerminalStore((s) => s.openSession);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });
  const projects = projectsQuery.data ?? [];
  const didSyncTargetFromProject = useRef(false);

  useEffect(() => {
    if (didSyncTargetFromProject.current || !projectsQuery.isSuccess) return;
    didSyncTargetFromProject.current = true;
    const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
    const fallback = project
      ? targetAIForProject(project.agentType, project.cliId)
      : DEFAULT_TARGET_AI;
    const untouched = !rawInput.trim() && !generated.trim();
    const next = resolvePromptTargetAI(targetAI, fallback, { untouched });
    const followProject =
      untouched &&
      (targetAI === 'Claude' || targetAI === DEFAULT_TARGET_AI) &&
      fallback !== targetAI;
    const resolved = followProject ? fallback : next;
    if (resolved !== targetAI) setTargetAI(resolved as TargetAI);
  }, [generated, projectId, projects, projectsQuery.isSuccess, rawInput, setTargetAI, targetAI]);

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });

  const trimmedHistorySearch = historySearch.trim();
  const historyQuery = useQuery({
    queryKey: trimmedHistorySearch
      ? queryKeys.promptHistorySearch(trimmedHistorySearch)
      : queryKeys.promptHistory,
    queryFn: () =>
      trimmedHistorySearch
        ? window.runova.promptHistory.search(trimmedHistorySearch)
        : window.runova.promptHistory.list(),
    enabled: historyOpen,
  });
  const historyEntries = historyQuery.data ?? [];

  // Voice input appends onto whatever's already in the box, so read the latest
  // value through a ref; the transcription callback outlives the render that
  // created it and would otherwise close over a stale rawInput.
  const rawInputRef = useRef(rawInput);
  useEffect(() => {
    rawInputRef.current = rawInput;
  }, [rawInput]);

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

  useEffect(() => {
    if (voice.error) toast.error(voice.error);
  }, [voice.error]);

  const saveTemplateMutation = useMutation({
    mutationFn: () =>
      window.runova.templates.save({
        name: templateName,
        promptType,
        targetAI,
        content: generated,
      }),
    onSuccess: () => {
      toast.success('Template saved.');
      setSaveDialogOpen(false);
      setTemplateName('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates });
    },
  });

  const saveDraftMutation = useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error('No project selected');
      return window.runova.projectDrafts.create({
        projectId,
        rawInput,
        promptType,
        targetAI,
        content: generated,
      });
    },
    onSuccess: () => {
      toast.success('Draft saved. Find it under the project’s Prompts section.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectDrafts(projectId!) });
    },
    onError: () => toast.error('Could not save the draft.'),
  });

  const saveScheduleMutation = useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error('No project selected');
      return window.runova.scheduledTasks.createMany({
        projectId,
        tasks: scheduleQueue.map((item) => ({
          rawInput: item.text,
          promptType,
          targetAI,
          content: generatePrompt({ rawInput: item.text, promptType, targetAI }),
          runAt: new Date(item.runAt).toISOString(),
          runMode: seriesRunMode,
          cliId: seriesRun.cliId,
          model: seriesRun.model,
          effort: seriesRun.effort,
        })),
      });
    },
    onSuccess: () => {
      toast.success('Scheduled series saved. Find it under the project’s Prompts section.');
      setScheduleQueue([]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks(projectId!) });
    },
    onError: () => toast.error('Could not save the schedule.'),
  });

  function addQueueItem(): void {
    setScheduleQueue((items) => [
      ...items,
      { id: crypto.randomUUID(), text: rawInput, runAt: defaultRunAt() },
    ]);
  }

  function updateQueueItem(id: string, updates: Partial<Omit<ScheduleQueueItem, 'id'>>): void {
    setScheduleQueue((items) =>
      items.map((item) => (item.id === id ? { ...item, ...updates } : item)),
    );
  }

  function removeQueueItem(id: string): void {
    setScheduleQueue((items) => items.filter((item) => item.id !== id));
  }

  const canSaveSchedule =
    !!projectId &&
    scheduleQueue.length > 0 &&
    scheduleQueue.every((item) => item.text.trim() && item.runAt);

  const runRecommendation = useRunRecommendation({
    jobKey: 'prompt-builder',
    generated,
    promptType,
    targetAI,
  });

  // Speak prompt skips Generate and Translate, so it is always heard as English: the words land
  // in the prompt exactly as spoken, never translated. Like a translation, the result was not
  // shaped by a prompt type, so it is sized without one.
  const generatedRef = useRef(generated);
  generatedRef.current = generated;
  const runRecommendationRef = useRef(runRecommendation);
  runRecommendationRef.current = runRecommendation;
  const promptVoice = useVoiceInput({
    language: 'en',
    onText: (text) => {
      const existing = generatedRef.current.trim();
      const next = existing ? `${existing} ${text}` : text;
      setGenerated(next);
      runRecommendationRef.current.analyze({ prompt: next, isTranslation: true });
    },
  });
  const promptTranscribing = promptVoice.status === 'transcribing';

  useEffect(() => {
    if (promptVoice.error) toast.error(promptVoice.error);
  }, [promptVoice.error]);

  // Escape throws away what a mic is recording or transcribing. It is only listened for while
  // one is busy, so the rest of the time Escape does what it always did.
  const micsRef = useRef([voice, promptVoice]);
  micsRef.current = [voice, promptVoice];
  const anyMicBusy = [voice, promptVoice].some(
    (mic) => mic.status === 'recording' || mic.status === 'transcribing',
  );
  useEffect(() => {
    if (!anyMicBusy) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && cancelBusyMics(micsRef.current)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [anyMicBusy]);

  const cliForSendTo = useMemo(() => {
    const cliId = defaultCliId ?? cliIdForTargetAI(targetAI);
    return CLI_REGISTRY.find((c) => c.id === cliId) ?? null;
  }, [defaultCliId, targetAI]);

  async function logHistory(source: 'generate' | 'translate', content: string): Promise<void> {
    try {
      // A plain translation isn't shaped by a prompt type or aimed at a particular AI,
      // so neither field applies; record them empty rather than whatever the pickers hold.
      const isTranslation = source === 'translate';
      await window.runova.promptHistory.add({
        rawInput,
        promptType: isTranslation ? '' : promptType,
        targetAI: isTranslation ? '' : targetAI,
        content,
        source,
        projectId,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.promptHistory });
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projectPromptHistory(projectId) });
      }
    } catch {
      // History logging is best-effort; a failure here shouldn't interrupt the user's flow.
    }
  }

  /** Pull a past prompt back into the builder so it can be tweaked and re-run. */
  function restoreFromHistory(entry: PromptHistoryEntry): void {
    setRawInput(entry.rawInput);
    // Translations carry no prompt type or target AI, so leave the pickers as they are.
    // Otherwise they're stored as plain strings, so only adopt values the pickers still know about.
    if (entry.source !== 'translate') {
      if ((PROMPT_TYPES as readonly string[]).includes(entry.promptType)) {
        setPromptType(entry.promptType as PromptType);
      }
      if (isTargetAI(entry.targetAI)) {
        setTargetAI(normalizeTargetAI(entry.targetAI) as TargetAI);
      }
    }
    setGenerated(entry.content);
    setHistoryOpen(false);
    toast.success('Loaded from history.');
  }

  async function handleGenerate(): Promise<void> {
    if (!rawInput.trim()) {
      toast.error('Describe what you want before generating a prompt.');
      return;
    }

    const settings = settingsQuery.data ?? (await window.runova.settings.get());
    const provider = settings.promptBuilderProvider;
    const model =
      provider === 'openai'
        ? settings.openaiModel
        : provider === 'gemini'
          ? settings.geminiModel
          : settings.ollamaModel;
    if (!model.trim()) {
      toast.error(`Set a ${provider} model in Settings first.`);
      return;
    }

    setGenerated('');
    runRecommendation.cancel();
    setIsGenerating(true);
    try {
      // Normalize the description to English before it's inserted into the AI request,
      // regardless of what language the user typed it in.
      const englishInput = await window.runova.translate.text({
        text: rawInput,
        targetLang: 'en',
      });
      const request = buildPromptGenerationRequest({
        rawInput: englishInput || rawInput,
        promptType,
        targetAI,
      });
      const result = await window.runova.ai.ask({ provider, model, prompt: request });
      if (!result.ok) {
        toast.error(result.error || 'Prompt generation failed.');
        return;
      }
      const content = result.text.trim();
      setGenerated(content);
      void logHistory('generate', content);
      // Size the fresh prompt with the default AI CLI so the run suggestion matches it.
      runRecommendation.analyze({ prompt: content });
    } catch (error) {
      toast.error((error as Error).message || 'Prompt generation failed.');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleTranslate(): Promise<void> {
    if (!rawInput.trim()) {
      toast.error('Enter some text before translating.');
      return;
    }
    setGenerated('');
    runRecommendation.cancel();
    setIsTranslating(true);
    try {
      const translated = await window.runova.translate.text({ text: rawInput, targetLang });
      setGenerated(translated);
      void logHistory('translate', translated);
      runRecommendation.analyze({ prompt: translated, isTranslation: true });
    } catch {
      toast.error('Translation failed. Check your internet connection and try again.');
    } finally {
      setIsTranslating(false);
    }
  }

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(generated);
    toast.success('Copied to clipboard.');
  }

  function handleClear(): void {
    runRecommendation.cancel();
    setRawInput('');
    setGenerated('');
  }

  async function handleExportMarkdown(): Promise<void> {
    const savedPath = await window.runova.fs.saveFileAs('prompt.md', generated);
    if (savedPath) toast.success(`Saved to ${savedPath}`);
  }

  async function handleSendToCli(): Promise<void> {
    if (!cliForSendTo) {
      toast.error('No CLI available for this target. Set a default CLI in Settings.');
      return;
    }
    const filePath = await window.runova.fs.writeScratchFile(`prompt-${Date.now()}.md`, generated);
    // Model and effort flags only mean something to the CLI they were picked for.
    const runArgs =
      cliForSendTo.id === runRecommendation.recommendation?.profile.cliId
        ? runRecommendation.args
        : [];
    const launch = cliLaunchCommand(cliForSendTo.id, runArgs) ?? cliForSendTo.executableNames[0];
    const command =
      window.runova.platform === 'win32'
        ? `& ${launch} (Get-Content -Raw -LiteralPath "${filePath}")`
        : `${launch} "$(cat '${filePath}')"`;
    openSession({ title: cliForSendTo.name, initialInput: command });
  }

  usePageHeader(
    'Prompt Builder',
    'Describe what you want; Runova structures it into a professional prompt.',
  );

  const generateShortcut = window.runova?.platform === 'darwin' ? '⌘ Enter' : 'Ctrl+Enter';

  return (
    // The page sits in the content island already, so the composer and the output are two glass
    // cards on it with a small gap, like the API Client. Below lg they stack and the page scrolls.
    <div className="flex w-full flex-1 flex-col gap-2 p-2 lg:h-full lg:min-h-0 lg:flex-row">
      <section aria-label="Compose" className={cn(PANEL, 'lg:min-h-0 lg:flex-1')}>
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:overflow-y-auto">
          <div className="flex min-h-[13rem] flex-1 flex-col gap-1.5">
            <Label htmlFor="raw-input" className={cn(SECTION_HEADING, 'px-1.5 pt-0.5')}>
              Your request
            </Label>
            {/* The request and the button that acts on it are one rounded field, the way a chat
                composer is: write in the top, send from the bottom right. */}
            <div className="search-pill flex min-h-0 flex-1 flex-col rounded-[1.25rem] transition-colors">
              <GrammarTextarea
                id="raw-input"
                containerClassName="flex min-h-[7rem] flex-1 flex-col"
                className="min-h-[7rem] flex-1 resize-none rounded-[1.25rem] border-0 bg-transparent px-4 pb-2 pt-3 text-sm leading-relaxed shadow-none focus-visible:ring-0"
                placeholder="e.g. Add a login form with email/password validation…"
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
                    e.preventDefault();
                    if (!isGenerating) void handleGenerate();
                  }
                }}
              />
              <div className="flex items-center gap-1.5 p-2 pl-2.5">
                {voice.supported && (
                  <VoiceRecordButton
                    voice={voice}
                    idleText="Dictate"
                    idleLabel="Dictate your request"
                    blockedReason={promptVoice.status !== 'idle' ? OTHER_MIC_BUSY : null}
                  />
                )}
                {/* A recording takes the language chip's and the hint's room, so the row keeps its height. */}
                {voice.status === 'recording' ? (
                  <VoiceRecordingStrip voice={voice} />
                ) : (
                  <>
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
                    <span className="hidden truncate text-[11px] text-muted-foreground/70 sm:inline">
                      {generateShortcut} to generate
                    </span>
                  </>
                )}
                <Button
                  className="ml-auto shrink-0"
                  onClick={() => void handleGenerate()}
                  disabled={isGenerating}
                >
                  {isGenerating ? <Spinner className="animate-spin" /> : <Sparkles />}
                  {isGenerating ? 'Generating…' : 'Generate Prompt'}
                </Button>
              </div>
            </div>
          </div>

          <div className="settings-rows -mx-3 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
            <OptionRow label="Prompt Type">
              <Combobox
                className={OPTION_CONTROL}
                value={promptType}
                onChange={(v) => setPromptType(v as PromptType)}
                options={PROMPT_TYPES.map((type) => ({ value: type, label: type }))}
              />
            </OptionRow>
            <OptionRow label="Target AI">
              <Combobox
                className={OPTION_CONTROL}
                value={targetAI}
                onChange={(v) => setTargetAI(v as TargetAI)}
                options={TARGET_AIS.map((ai) => ({
                  value: ai,
                  label: ai,
                  icon: cliOptionIcon(cliIdForTargetAI(ai)),
                }))}
              />
            </OptionRow>
            <OptionRow label="Project">
              <Combobox
                className={OPTION_CONTROL}
                value={projectId ?? ''}
                onChange={(v) => {
                  const nextId = v || null;
                  setProjectId(nextId);
                  if (!nextId) return;
                  const project = projects.find((p) => p.id === nextId);
                  if (project) {
                    setTargetAI(targetAIForProject(project.agentType, project.cliId) as TargetAI);
                  }
                }}
                placeholder="No project"
                emptyText="No projects yet."
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
                clearable
              />
            </OptionRow>
            <OptionRow label="Status" id="prompt-status-label">
              <LayoutGroup id="prompt-builder-status">
                <div
                  role="group"
                  aria-labelledby="prompt-status-label"
                  className="search-pill flex h-8 shrink-0 items-center gap-0.5 rounded-full p-0.5"
                >
                  {STATUS_OPTIONS.map((option) => {
                    const active = status === option.value;
                    const Icon = option.value === 'draft' ? FileText : CalendarDays;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setStatus(option.value)}
                        className={cn(
                          'relative isolate flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {active && (
                          <motion.span
                            aria-hidden
                            layoutId="prompt-builder-status-active"
                            transition={pillTransition}
                            className="absolute inset-0 -z-10 rounded-full bg-primary/12"
                          />
                        )}
                        <Icon className="h-3.5 w-3.5" />
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </LayoutGroup>
            </OptionRow>
          </div>

          {status === 'draft' && (
            <div className={cn(WELL, 'space-y-3')}>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {projectId
                  ? 'Parks this request (with the prompt type, target AI, and generated prompt it was built with) in the project’s Prompts section, where you can finish it and schedule it later.'
                  : 'Choose a project above to park this request on it as a draft.'}
              </p>
              <Button
                variant="soft"
                className="w-full"
                disabled={!projectId || !rawInput.trim() || saveDraftMutation.isPending}
                onClick={() => saveDraftMutation.mutate()}
              >
                <Save /> {saveDraftMutation.isPending ? 'Saving…' : 'Save draft to project'}
              </Button>
            </div>
          )}

          {status === 'scheduled' && (
            <div className={cn(WELL, 'space-y-3')}>
              <div className="flex items-center justify-between gap-2">
                <p className={SECTION_HEADING}>Scheduled series</p>
                <Button variant="soft" size="sm" onClick={addQueueItem}>
                  <Plus /> Add task
                </Button>
              </div>

              {!projectId && (
                <p className="text-xs text-muted-foreground">
                  Choose a project above so this series has somewhere to run later.
                </p>
              )}

              <div className="space-y-1.5">
                <Label className="text-xs">Run</Label>
                <Combobox
                  value={seriesRunMode}
                  onChange={(v) => setSeriesRunMode(v as ScheduledTaskRunMode)}
                  options={[
                    { value: 'auto', label: 'Automatically at each time' },
                    { value: 'manual', label: 'Manually, when I press Run' },
                  ]}
                />
              </div>
              <RunSettingsFields value={seriesRun} onChange={setSeriesRun} />

              {scheduleQueue.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No tasks queued yet. Add one to build a series of prompts to run on this project
                  later.
                </p>
              ) : (
                <div className="space-y-2">
                  {scheduleQueue.map((item, index) => (
                    <div
                      key={item.id}
                      className="glass space-y-1.5 rounded-[calc(var(--radius)+2px)] p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/12 text-[10px] font-semibold tabular-nums text-primary">
                            {index + 1}
                          </span>
                          Task {index + 1}
                        </span>
                        <SimpleTooltip label="Remove task">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`Remove task ${index + 1}`}
                            onClick={() => removeQueueItem(item.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </SimpleTooltip>
                      </div>
                      <Textarea
                        rows={2}
                        placeholder="What should run at this time?"
                        value={item.text}
                        onChange={(e) => updateQueueItem(item.id, { text: e.target.value })}
                      />
                      <div
                        className={cn(
                          'flex items-center gap-1.5',
                          seriesRunMode === 'manual' && 'hidden',
                        )}
                      >
                        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <Input
                          type="datetime-local"
                          className="h-8 text-xs"
                          value={item.runAt}
                          onChange={(e) => updateQueueItem(item.id, { runAt: e.target.value })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Button
                className="w-full"
                disabled={!canSaveSchedule || saveScheduleMutation.isPending}
                onClick={() => saveScheduleMutation.mutate()}
              >
                <CalendarDays />{' '}
                {saveScheduleMutation.isPending
                  ? 'Saving…'
                  : `Save ${scheduleQueue.length || ''} task(s) to schedule`}
              </Button>
            </div>
          )}

          <div className="space-y-1.5">
            <p className={cn(SECTION_HEADING, 'px-1.5')}>Or translate directly</p>
            {/* Language and Translate share one pill, like the API Client's URL bar. */}
            <div className="search-pill flex h-10 items-center gap-1 rounded-full p-1 pl-3 transition-colors">
              <Languages className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <Combobox
                ariaLabel="Translate to"
                variant="bare"
                className="h-8 min-w-0 flex-1 px-2 hover:bg-foreground/[0.05]"
                value={targetLang}
                onChange={setTargetLang}
                options={TRANSLATE_LANGUAGES}
              />
              <Button
                variant="soft"
                className="shrink-0"
                onClick={() => void handleTranslate()}
                disabled={isTranslating}
              >
                {isTranslating ? <Spinner className="animate-spin" /> : <Languages />}
                {isTranslating ? 'Translating…' : 'Translate'}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section
        aria-label="Prompt output"
        className={cn(PANEL, '@container/output lg:min-h-0 lg:flex-1')}
      >
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 pl-4 pr-2">
          <h2 className={cn(SECTION_HEADING, 'shrink-0 whitespace-nowrap')}>Generated prompt</h2>
          {promptVoice.supported && (
            <div className="ml-auto flex min-w-0 items-center gap-1.5">
              {promptVoice.status === 'recording' && <VoiceRecordingStrip voice={promptVoice} />}
              <VoiceRecordButton
                voice={promptVoice}
                idleText="Speak prompt"
                idleLabel={SPEAK_PROMPT_LABEL}
                blockedReason={
                  voice.status !== 'idle'
                    ? OTHER_MIC_BUSY
                    : isGenerating || isTranslating
                      ? 'Wait for the prompt to finish'
                      : null
                }
              />
            </div>
          )}
          <SimpleTooltip label="Browse previously generated prompts">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 px-2.5 text-muted-foreground hover:text-foreground"
              type="button"
              onClick={() => setHistoryOpen(true)}
            >
              <History />
              <span>History</span>
            </Button>
          </SimpleTooltip>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3 lg:overflow-y-auto">
          <div className="relative flex min-h-[14rem] flex-1 flex-col">
            <MonacoEditor
              value={generated}
              onChange={setGenerated}
              className="min-h-[14rem] flex-1 rounded-xl border-0 ring-1 ring-foreground/[0.08]"
            />
            {isGenerating || isTranslating ? (
              <div
                role="status"
                aria-label={isGenerating ? 'Generating prompt' : 'Translating'}
                className="absolute inset-0 z-10 space-y-2.5 rounded-xl bg-background/90 p-4"
              >
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ) : promptTranscribing ? (
              <div
                role="status"
                aria-label="Writing down what you said"
                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-background/80 backdrop-blur-[2px]"
              >
                <Spinner className="h-5 w-5 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">
                  {promptVoice.downloadPercent !== null
                    ? `Downloading speech model… ${promptVoice.downloadPercent}%`
                    : 'Writing down what you said…'}
                </p>
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  className="mt-1"
                  onClick={promptVoice.cancel}
                >
                  Cancel
                </Button>
              </div>
            ) : !generated ? (
              // Clicks fall through, so the editor stays usable for pasting a prompt by hand.
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Your prompt shows up here</p>
                  <p className="text-xs text-muted-foreground">
                    Describe the task on the left and press Generate or Translate, or speak the
                    prompt itself in English.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
          {/* On a narrow card the two quieter actions drop to their icons, so the row stays one line. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button disabled={!generated} onClick={() => void handleSendToCli()}>
              <TerminalSquare /> Send to CLI
            </Button>
            <SimpleTooltip
              label="Break this into tasks that each fit one AI session, and run them in order"
              wrapTrigger={!generated.trim() && !rawInput.trim()}
            >
              <Button
                variant="soft"
                aria-label="Split into tasks"
                className="px-2.5 @[34rem]/output:px-3"
                disabled={!generated.trim() && !rawInput.trim()}
                onClick={() => setSplitOpen(true)}
              >
                <ListTodo /> <span className="hidden @[34rem]/output:inline">Split into tasks</span>
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Save Template">
              <Button
                variant="soft"
                aria-label="Save Template"
                className="px-2.5 @[34rem]/output:px-3"
                disabled={!generated}
                onClick={() => setSaveDialogOpen(true)}
              >
                <Save /> <span className="hidden @[34rem]/output:inline">Save Template</span>
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Export Markdown">
              <Button
                variant="soft"
                aria-label="Export Markdown"
                className="px-2.5 @[34rem]/output:px-3"
                disabled={!generated}
                onClick={() => void handleExportMarkdown()}
              >
                <Download /> <span className="hidden @[34rem]/output:inline">Export Markdown</span>
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Copy" wrapTrigger={!generated}>
              <Button
                variant="soft"
                size="icon"
                aria-label="Copy"
                disabled={!generated}
                onClick={() => void handleCopy()}
              >
                <Copy />
              </Button>
            </SimpleTooltip>
            <span aria-hidden className="flex-1" />
            <SimpleTooltip label="Clear" wrapTrigger={!rawInput && !generated}>
              <Button
                variant="ghost"
                size="icon"
                className="hover:bg-destructive/10 hover:text-destructive"
                aria-label="Clear"
                disabled={!rawInput && !generated}
                onClick={handleClear}
              >
                <Trash2 />
              </Button>
            </SimpleTooltip>
          </div>
          <RunRecommendationPanel
            state={runRecommendation}
            collapsibleKey="promptBuilder.runPanelCollapsed"
            className={cn(WELL, 'shrink-0')}
          />
        </div>
      </section>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Prompt history</DialogTitle>
            <DialogDescription>
              Pick a past prompt to load it back into the builder.
            </DialogDescription>
          </DialogHeader>

          <div className="search-pill flex h-9 items-center gap-2 rounded-full pl-3.5 pr-1.5 transition-colors">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
              placeholder="Search prompt history…"
              aria-label="Search prompt history"
              spellCheck={false}
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
          </div>

          <div className="max-h-[50vh] overflow-y-auto">
            {historyQuery.isLoading ? (
              <div role="status" aria-label="Loading history" className="space-y-1.5">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="space-y-2 rounded-xl px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                      <Skeleton className="ml-auto h-3 w-24" />
                    </div>
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                ))}
              </div>
            ) : historyQuery.isError ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">Couldn’t load prompt history.</p>
                <Button variant="soft" onClick={() => void historyQuery.refetch()}>
                  Try again
                </Button>
              </div>
            ) : historyEntries.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
                  {trimmedHistorySearch ? (
                    <Search className="h-5 w-5" />
                  ) : (
                    <History className="h-5 w-5" />
                  )}
                </div>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {trimmedHistorySearch
                    ? `No prompts match “${trimmedHistorySearch}”.`
                    : 'Nothing here yet. Generate or translate a prompt and it will show up.'}
                </p>
              </div>
            ) : (
              <div className="settings-rows overflow-hidden rounded-xl ring-1 ring-inset ring-foreground/[0.08]">
                {historyEntries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="block w-full space-y-1.5 px-3.5 py-3 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] focus-visible:outline-none"
                    onClick={() => restoreFromHistory(entry)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {entry.source === 'translate' ? (
                          <>
                            <span className="text-sm font-medium">Translation</span>
                            <HistoryChip tone="success">
                              <Languages /> Translated
                            </HistoryChip>
                          </>
                        ) : (
                          <>
                            <span className="text-sm font-medium">{entry.promptType}</span>
                            <HistoryChip>{entry.targetAI}</HistoryChip>
                            <HistoryChip tone="primary">
                              <Sparkles /> Generated
                            </HistoryChip>
                          </>
                        )}
                      </div>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                      {entry.content}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="soft"
              onClick={() => {
                setHistoryOpen(false);
                navigate('/prompt-history');
              }}
            >
              <ExternalLink /> Open full history
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save prompt template</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Template name"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
          />
          <DialogFooter>
            <Button
              disabled={!templateName.trim() || saveTemplateMutation.isPending}
              onClick={() => saveTemplateMutation.mutate()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SplitIntoTasksDialog
        open={splitOpen}
        onOpenChange={setSplitOpen}
        request={generated.trim() || rawInput.trim()}
        projectId={null}
        defaultProjectId={projectId}
      />
    </div>
  );
}

/** One of the page's two cards: the app's glass card, rounded like the Settings cards. */
const PANEL = 'glass flex flex-col overflow-hidden rounded-[calc(var(--radius)+2px)]';

/** A soft inset area inside a card, for the panels that open under a choice. */
const WELL = 'rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/[0.07]';

/** The pickers in the option rows, sized so their right edges line up. */
const OPTION_CONTROL = 'h-8 w-[min(15rem,62%)] rounded-full';

/**
 * One option as a row: what it is on the left, its picker on the right edge, the way the Settings
 * rows are laid out. The label and the control stay siblings so the label names the field.
 */
function OptionRow({
  label,
  id,
  children,
}: {
  label: string;
  id?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 px-4 py-2">
      <Label id={id} className="text-[13px] font-medium text-foreground/85">
        {label}
      </Label>
      {children}
    </div>
  );
}

function HistoryChip({
  tone = 'neutral',
  children,
}: {
  tone?: 'primary' | 'success' | 'neutral';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium [&_svg]:h-3 [&_svg]:w-3',
        tone === 'primary' && 'bg-primary/12 text-primary',
        tone === 'success' && 'bg-success/12 text-success',
        tone === 'neutral' && 'bg-foreground/[0.06] text-foreground/80',
      )}
    >
      {children}
    </span>
  );
}
