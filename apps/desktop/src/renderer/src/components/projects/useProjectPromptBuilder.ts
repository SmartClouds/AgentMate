import type { PromptType, TargetAI } from '@agentmat/core';
import {
  buildPromptGenerationRequest,
  DEFAULT_TARGET_AI,
  resolvePromptTargetAI,
  targetAIForProject,
} from '@agentmat/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { promptProviderModel } from '@/lib/promptProvider';
import { queryKeys } from '@/lib/queryKeys';
import { queryClient } from '@/queryClient';
import { useProjectPromptBuildStore } from '@/stores/projectPromptBuildStore';
import {
  beginPromptTask,
  cancelPromptTask,
  cancelRunAssessment,
  finishPromptTask,
  isCurrentPromptTask,
  projectPromptJobKey,
  startRunAssessment,
  usePromptJobsStore,
} from '@/stores/promptJobsStore';

/**
 * Shared Build Prompt state/handlers behind the dialog and its pinned desktop
 * widget. Both render the same generate/translate/copy/save-draft flow over
 * the same per-project entry, just in different chrome.
 */
export interface UseProjectPromptBuilderOptions {
  /** Skip fetching settings while the dialog/widget isn't visible yet. */
  enabled?: boolean;
  onDraftSaved?: () => void;
  /** Size what Generate or Translate produced, for forms that show the run recommendation. */
  sizeResults?: boolean;
  /**
   * Project name for a "ready" toast when a result lands while the form is closed. Set by
   * forms that can be closed mid-request and report their visibility to the prompt jobs store.
   */
  notifyWhenHidden?: string;
}

/**
 * Generate and Translate keep running after the dialog closes or the page changes. Their
 * progress lives in the prompt jobs store and their result in the persisted per-project entry,
 * so reopening the dialog picks up wherever the request is.
 */
export function useProjectPromptBuilder(
  projectId: string,
  {
    enabled = true,
    onDraftSaved,
    sizeResults = false,
    notifyWhenHidden,
  }: UseProjectPromptBuilderOptions = {},
) {
  const stored = useProjectPromptBuildStore((s) => s.entries[projectId]);
  const rawInput = stored?.rawInput ?? '';
  const promptType = stored?.promptType ?? 'Full Stack';
  const generated = stored?.generated ?? '';
  const generatedSource = stored?.generatedSource;
  const updateEntry = useProjectPromptBuildStore((s) => s.update);
  const setRawInput = (v: string) => updateEntry(projectId, { rawInput: v });
  const setPromptType = (v: PromptType) => updateEntry(projectId, { promptType: v });
  const setTargetAI = (v: TargetAI) => updateEntry(projectId, { targetAI: v });
  const setGenerated = (v: string) => updateEntry(projectId, { generated: v });
  const setGeneratedResult = (v: string, source: 'generate' | 'translate' | 'dictate') =>
    updateEntry(projectId, { generated: v, generatedSource: source });
  const clearEntry = useProjectPromptBuildStore((s) => s.clear);
  const jobKey = projectPromptJobKey(projectId);
  const handleClear = () => {
    // Anything still on its way would otherwise refill the form the user just emptied.
    cancelPromptTask(jobKey);
    cancelRunAssessment(jobKey);
    clearEntry(projectId);
  };
  const taskKind = usePromptJobsStore((s) => s.tasks[jobKey]?.kind);
  const isGenerating = taskKind === 'generate';
  const isTranslating = taskKind === 'translate';

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.agentmat.settings.get(),
    enabled,
  });

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
    enabled,
  });
  const project = projectsQuery.data?.find((p) => p.id === projectId);
  const fallbackTargetAI = project
    ? targetAIForProject(project.agentType, project.cliId)
    : DEFAULT_TARGET_AI;
  const targetAI = resolvePromptTargetAI(stored?.targetAI, fallbackTargetAI, {
    untouched: !rawInput.trim() && !generated.trim(),
  }) as TargetAI;

  /** A prompt spoken straight into the output box, kept word for word. */
  const setDictatedPrompt = (v: string) => {
    cancelRunAssessment(jobKey);
    setGeneratedResult(v, 'dictate');
    // Sized like a translation: it was never shaped by the prompt type.
    if (sizeResults) startRunAssessment(jobKey, { prompt: v, targetAI });
  };

  useEffect(() => {
    if (!enabled || !projectId || projectsQuery.isLoading) return;
    if (stored?.targetAI === targetAI) return;
    updateEntry(projectId, { targetAI });
  }, [enabled, projectId, projectsQuery.isLoading, stored?.targetAI, targetAI, updateEntry]);

  const saveDraftMutation = useMutation({
    mutationFn: () =>
      window.agentmat.projectDrafts.create({
        projectId,
        rawInput,
        promptType,
        targetAI,
        content: generated,
      }),
    onSuccess: () => {
      toast.success('Draft saved. Find it on the project’s Overview tab.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectDrafts(projectId) });
      onDraftSaved?.();
    },
    onError: () => toast.error('Could not save the draft.'),
  });

  // Everything below the first await may run after the dialog has closed or the page has
  // changed, so it only touches stores and the shared query client, never component state.
  // The request fields are captured up front: the user can keep typing while it runs.
  async function logHistory(
    source: 'generate' | 'translate',
    request: { rawInput: string; promptType: PromptType; targetAI: TargetAI },
    content: string,
  ): Promise<void> {
    try {
      const isTranslation = source === 'translate';
      await window.agentmat.promptHistory.add({
        rawInput: request.rawInput,
        promptType: isTranslation ? '' : request.promptType,
        targetAI: isTranslation ? '' : request.targetAI,
        content,
        source,
        projectId,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.promptHistory });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectPromptHistory(projectId) });
    } catch {
      // History logging is best-effort, a failure here shouldn't interrupt the user's flow.
    }
  }

  /** Tells the user a result is waiting when the form they started it from is closed. */
  function announceIfHidden(message: string): void {
    if (!notifyWhenHidden || usePromptJobsStore.getState().visible[jobKey]) return;
    toast.success(message);
  }

  async function handleGenerate(): Promise<void> {
    if (usePromptJobsStore.getState().tasks[jobKey]) return;
    if (!rawInput.trim()) {
      toast.error('Describe what you want before generating a prompt.');
      return;
    }

    const settings = settingsQuery.data ?? (await window.agentmat.settings.get());
    const { provider, model } = promptProviderModel(settings);
    if (!model.trim()) {
      toast.error(`Set a ${provider} model in Settings first.`);
      return;
    }

    const task = beginPromptTask(jobKey, 'generate', crypto.randomUUID());
    if (!task) return;
    const request = { rawInput, promptType, targetAI };
    // Drop the previous result immediately so a failed request can't leave
    // stale text in the box for the user to copy by mistake.
    cancelRunAssessment(jobKey);
    setGenerated('');
    try {
      const result = await window.agentmat.ai.ask({
        provider,
        model,
        prompt: buildPromptGenerationRequest(request),
        requestId: task.requestId,
      });
      if (!isCurrentPromptTask(jobKey, task) || result.cancelled) return;
      if (!result.ok) {
        toast.error(result.error || 'Prompt generation failed.');
        return;
      }
      const content = result.text.trim();
      setGeneratedResult(content, 'generate');
      void logHistory('generate', request, content);
      if (sizeResults) {
        startRunAssessment(jobKey, {
          prompt: content,
          targetAI: request.targetAI,
          promptType: request.promptType,
        });
      }
      announceIfHidden(`Prompt for ${notifyWhenHidden} is ready.`);
    } catch (error) {
      if (!isCurrentPromptTask(jobKey, task)) return;
      toast.error((error as Error).message || 'Prompt generation failed.');
    } finally {
      finishPromptTask(jobKey, task);
    }
  }

  async function handleTranslate(): Promise<void> {
    if (!rawInput.trim()) {
      toast.error('Enter some text before translating.');
      return;
    }
    const task = beginPromptTask(jobKey, 'translate', crypto.randomUUID());
    if (!task) return;
    const request = { rawInput, promptType, targetAI };
    cancelRunAssessment(jobKey);
    setGenerated('');
    try {
      const translated = await window.agentmat.translate.text({
        text: request.rawInput,
        targetLang: 'en',
        requestId: task.requestId,
      });
      if (!isCurrentPromptTask(jobKey, task)) return;
      setGeneratedResult(translated, 'translate');
      void logHistory('translate', request, translated);
      if (sizeResults) {
        startRunAssessment(jobKey, { prompt: translated, targetAI: request.targetAI });
      }
      announceIfHidden(`Translation for ${notifyWhenHidden} is ready.`);
    } catch {
      if (!isCurrentPromptTask(jobKey, task)) return;
      toast.error('Translation failed. Check your internet connection and try again.');
    } finally {
      finishPromptTask(jobKey, task);
    }
  }

  /** Stops a Generate or Translate that is taking too long, keeping the request text. */
  function handleCancel(): void {
    cancelPromptTask(jobKey);
  }

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(generated);
    toast.success('Copied to clipboard.');
  }

  return {
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
  };
}
