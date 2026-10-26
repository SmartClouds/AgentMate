import type { BlueprintAttachment, BlueprintStepId, Project, ProjectBlueprint } from '@runova/core';
import {
  AGENT_TYPE_LABELS,
  blueprintTextHash,
  buildBlueprintGenerationRequest,
  buildBlueprintPrompt,
  getCliDefinition,
  targetAIForProject,
} from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { containsPersian } from '@/lib/rtl';
import type { BlueprintGeneratorChoice } from '@/stores/blueprintGeneratorStore';

/**
 * Section saves and attachment writes happen constantly while the wizard is
 * open, and each one already has its own inline state. Opting them out of the
 * app-wide overlay keeps the page from flashing on every blur.
 */
const QUIET = { silentLoading: true } as const;

export type GenerateStage = 'idle' | 'translating' | 'writing';

export function useProjectBlueprint(project: Project) {
  const projectId = project.id;
  const queryClient = useQueryClient();
  const [generateStage, setGenerateStage] = useState<GenerateStage>('idle');
  // The generation in flight, so Cancel can stop the right request on the right path.
  const activeRequest = useRef<{ id: string; viaCli: boolean; sent: boolean } | null>(null);
  // Files that have just been written and are waiting for the editor to place
  // them at the caret. The editor clears the queue once it has.
  const [pendingInserts, setPendingInserts] = useState<BlueprintAttachment[]>([]);
  const clearPendingInserts = useCallback(() => setPendingInserts([]), []);

  const blueprintQuery = useQuery({
    queryKey: queryKeys.blueprint(projectId),
    queryFn: () => window.runova.blueprints.get(projectId),
  });

  const presetsQuery = useQuery({
    queryKey: queryKeys.blueprintPresets,
    queryFn: () => window.runova.blueprints.listPresets(),
  });

  const agentFileQuery = useQuery({
    queryKey: queryKeys.blueprintAgentFile(projectId),
    queryFn: () => window.runova.blueprints.agentFileTarget(projectId),
  });

  function cache(next: ProjectBlueprint): void {
    queryClient.setQueryData(queryKeys.blueprint(projectId), next);
  }

  function refreshRevisions(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.blueprint(projectId) });
  }

  /**
   * Pushes the ticked sections into the project's CLAUDE.md / AGENTS.md. Runs
   * after a save rather than on every keystroke, and stays quiet when nothing
   * was ticked and there was nothing to remove.
   */
  async function syncAgentFile(announce: boolean): Promise<void> {
    try {
      const result = await window.runova.blueprints.syncAgentFile(projectId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.blueprintAgentFile(projectId) });
      if (announce && result.written) toast.success(`Updated ${result.relativePath}.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update the project's markdown file.",
      );
    }
  }

  const saveSection = useMutation({
    mutationFn: ({ stepId, text }: { stepId: BlueprintStepId; text: string }) =>
      window.runova.blueprints.updateSection(projectId, stepId, { text }),
    onSuccess: (next, variables) => {
      cache(next);
      refreshRevisions();
      const section = next.sections.find((entry) => entry.stepId === variables.stepId);
      if (section?.includeInAgentFile) void syncAgentFile(false);
    },
    onError: () => toast.error('Could not save that step.'),
    meta: QUIET,
  });

  const setIncludeInAgentFile = useMutation({
    mutationFn: ({ stepId, value }: { stepId: BlueprintStepId; value: boolean }) =>
      window.runova.blueprints.updateSection(projectId, stepId, { includeInAgentFile: value }),
    onSuccess: (next) => {
      cache(next);
      void syncAgentFile(true);
    },
    onError: () => toast.error('Could not change that step.'),
    meta: QUIET,
  });

  const setDocsFolder = useMutation({
    mutationFn: (folder: string) => window.runova.blueprints.setDocsFolder(projectId, folder),
    onSuccess: cache,
    meta: QUIET,
  });

  const setConfirmBeforeWriting = useMutation({
    mutationFn: (value: boolean) =>
      window.runova.blueprints.setConfirmBeforeWriting(projectId, value),
    onSuccess: cache,
    meta: QUIET,
  });

  const setRelay = useMutation({
    mutationFn: (value: { enabled: boolean; budgetTokens: number }) =>
      window.runova.blueprints.setRelay(projectId, value),
    onSuccess: cache,
    meta: QUIET,
  });

  const saveFinalPrompt = useMutation({
    mutationFn: (text: string) => window.runova.blueprints.setFinalPrompt(projectId, text),
    onSuccess: (next) => {
      cache(next);
      refreshRevisions();
      toast.success('Prompt saved.');
    },
    onError: () => toast.error('Could not save the prompt.'),
  });

  const pickAttachments = useMutation({
    mutationFn: (stepId: BlueprintStepId) =>
      window.runova.blueprints.pickAttachments(projectId, stepId),
    onSuccess: (result) => {
      // Null means the picker was cancelled, which isn't a failure or a change.
      if (!result) return;
      cache(result.blueprint);
      setPendingInserts((current) => [...current, ...result.added]);
    },
    onError: (error: Error) => toast.error(error.message || 'Could not attach that file.'),
    meta: QUIET,
  });

  const addAttachment = useMutation({
    mutationFn: ({
      stepId,
      displayName,
      dataUrl,
    }: {
      stepId: BlueprintStepId;
      displayName: string;
      dataUrl: string;
    }) => window.runova.blueprints.addAttachment(projectId, stepId, { displayName, dataUrl }),
    onSuccess: (result) => {
      cache(result.blueprint);
      setPendingInserts((current) => [...current, ...result.added]);
    },
    onError: (error: Error) => toast.error(error.message || 'Could not attach that file.'),
    meta: QUIET,
  });

  const renameAttachment = useMutation({
    mutationFn: ({
      stepId,
      attachmentId,
      displayName,
    }: {
      stepId: BlueprintStepId;
      attachmentId: string;
      displayName: string;
    }) => window.runova.blueprints.renameAttachment(projectId, stepId, attachmentId, displayName),
    onSuccess: cache,
    meta: QUIET,
  });

  const removeAttachment = useMutation({
    mutationFn: ({ stepId, attachmentId }: { stepId: BlueprintStepId; attachmentId: string }) =>
      window.runova.blueprints.removeAttachment(projectId, stepId, attachmentId),
    onSuccess: cache,
    onError: () => toast.error('Could not remove that attachment.'),
    meta: QUIET,
  });

  /**
   * Brings every non-empty section into English, reusing what is already cached.
   * A section the user wrote in English never leaves the machine; one that
   * failed to translate falls back to its original text rather than sinking the
   * whole run.
   */
  async function englishSections(
    blueprint: ProjectBlueprint,
  ): Promise<Map<BlueprintStepId, string>> {
    const english = new Map<BlueprintStepId, string>();
    let failed = 0;

    for (const section of blueprint.sections) {
      const text = section.text.trim();
      if (!text) continue;

      const hash = blueprintTextHash(text);
      if (section.textEn && section.textEnHash === hash) {
        english.set(section.stepId, section.textEn);
        continue;
      }

      if (!containsPersian(text)) {
        english.set(section.stepId, text);
        await window.runova.blueprints
          .updateSection(projectId, section.stepId, { textEn: text, textEnHash: hash })
          .then(cache)
          .catch(() => undefined);
        continue;
      }

      try {
        const translated = await window.runova.translate.text({ text, targetLang: 'en' });
        const value = translated.trim() || text;
        english.set(section.stepId, value);
        await window.runova.blueprints
          .updateSection(projectId, section.stepId, { textEn: value, textEnHash: hash })
          .then(cache)
          .catch(() => undefined);
      } catch {
        failed += 1;
        english.set(section.stepId, text);
      }
    }

    if (failed > 0) {
      toast.warning(
        `${failed} step${failed === 1 ? '' : 's'} could not be translated and went in as written.`,
      );
    }
    return english;
  }

  /**
   * Writes the prompt with `choice` and saves it. Resolves to the saved prompt, or null when
   * nothing was saved (no steps filled in, the user cancelled, or the save failed). The caller
   * announces success, since it is the one that can offer to run the prompt.
   */
  async function generate(choice: BlueprintGeneratorChoice): Promise<string | null> {
    const blueprint = blueprintQuery.data;
    if (!blueprint) return null;
    if (!blueprint.sections.some((section) => section.text.trim())) {
      toast.error('Fill in at least one step before generating the prompt.');
      return null;
    }

    const requestId = crypto.randomUUID();
    activeRequest.current = { id: requestId, viaCli: !!choice.cliId, sent: false };
    setGenerateStage('translating');
    try {
      const english = await englishSections(blueprint);
      const input = {
        projectName: project.name,
        agentLabel: AGENT_TYPE_LABELS[project.agentType],
        targetAI: targetAIForProject(project.agentType, project.cliId),
        docsFolder: blueprint.docsFolder,
        confirmBeforeWriting: blueprint.confirmBeforeWriting,
        relay: blueprint.relay,
        sections: blueprint.sections
          .filter((section) => english.has(section.stepId))
          .map((section) => ({
            stepId: section.stepId,
            text: english.get(section.stepId) ?? '',
            attachmentNames: section.attachments.map((attachment) => attachment.displayName),
          })),
      };

      // Cancelled while translating: stop before anything is sent to the AI.
      if (activeRequest.current?.id !== requestId) return null;
      activeRequest.current.sent = true;
      setGenerateStage('writing');
      const prompt = await writePrompt(input, choice, requestId);
      // A cancel that lost the race with the answer still means the user didn't want it.
      if (prompt === null || activeRequest.current?.id !== requestId) return null;

      // Saved directly rather than through saveFinalPrompt, whose "Prompt saved." toast would
      // land on top of the caller's "Prompt ready" one.
      try {
        cache(await window.runova.blueprints.setFinalPrompt(projectId, prompt));
        refreshRevisions();
      } catch {
        toast.error('Could not save the prompt.');
        return null;
      }
      void logHistory(projectId, input.targetAI, prompt);
      return prompt;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not generate the prompt.');
      return null;
    } finally {
      if (activeRequest.current?.id === requestId) activeRequest.current = null;
      setGenerateStage('idle');
    }
  }

  /** Stops the generation in flight. Nothing is saved and no template is put in its place. */
  function cancelGenerate(): void {
    const request = activeRequest.current;
    if (!request) return;
    activeRequest.current = null;
    // Still translating: nothing went to the AI yet, and the check after translation stops it.
    if (!request.sent) return;
    void (
      request.viaCli
        ? window.runova.ai.cancelAskCli(request.id)
        : window.runova.ai.cancel(request.id)
    ).catch(() => undefined);
  }

  return {
    blueprint: blueprintQuery.data,
    isLoading: blueprintQuery.isLoading,
    presets: presetsQuery.data ?? [],
    agentFile: agentFileQuery.data,
    saveSection,
    setIncludeInAgentFile,
    setDocsFolder,
    setConfirmBeforeWriting,
    setRelay,
    saveFinalPrompt,
    pickAttachments,
    addAttachment,
    pendingInserts,
    clearPendingInserts,
    renameAttachment,
    removeAttachment,
    syncAgentFile,
    generate,
    cancelGenerate,
    generateStage,
  };
}

/** "<what went wrong>. Assembled the prompt here instead." without doubling the full stop. */
function fellBack(message: string): void {
  toast.warning(`${message.trim().replace(/\.$/, '')}. Assembled the prompt here instead.`);
}

/**
 * Asks the chosen CLI, or the provider set in Settings, to write the prompt, and
 * falls back to the local template when there is no model or the request fails.
 * Translation needs no key but generation does, so without the fallback the
 * whole feature would be dead for anyone who never set one up. Resolves to null
 * when the user cancelled, so nothing is saved in its place.
 */
async function writePrompt(
  input: Parameters<typeof buildBlueprintPrompt>[0],
  choice: BlueprintGeneratorChoice,
  requestId: string,
): Promise<string | null> {
  const local = buildBlueprintPrompt(input);

  if (choice.cliId) {
    const name = getCliDefinition(choice.cliId)?.label ?? 'The CLI';
    try {
      const result = await window.runova.ai.askCli({
        prompt: buildBlueprintGenerationRequest(input),
        cliId: choice.cliId,
        modelId: choice.modelId,
        effort: choice.effort,
        requestId,
      });
      if (result.cancelled) return null;
      if (!result.ok || !result.text.trim()) {
        fellBack(result.error || `${name} did not answer`);
        return local;
      }
      return result.text.trim();
    } catch (error) {
      fellBack(error instanceof Error ? error.message : `${name} did not answer`);
      return local;
    }
  }

  const settings = await window.runova.settings.get();
  const provider = settings.promptBuilderProvider;
  const model =
    provider === 'openai'
      ? settings.openaiModel
      : provider === 'gemini'
        ? settings.geminiModel
        : settings.ollamaModel;

  if (!model.trim()) {
    toast.info(
      `Assembled the prompt here. Set a ${provider} model in Settings to have AI write it.`,
    );
    return local;
  }

  try {
    const result = await window.runova.ai.ask({
      provider,
      model,
      prompt: buildBlueprintGenerationRequest(input),
      requestId,
    });
    if (result.cancelled) return null;
    if (!result.ok || !result.text.trim()) {
      fellBack(result.error || 'The AI request failed');
      return local;
    }
    return result.text.trim();
  } catch (error) {
    fellBack(error instanceof Error ? error.message : 'The AI request failed');
    return local;
  }
}

async function logHistory(projectId: string, targetAI: string, content: string): Promise<void> {
  try {
    await window.runova.promptHistory.add({
      rawInput: '',
      promptType: 'Product',
      targetAI,
      content,
      source: 'generate',
      projectId,
    });
  } catch {
    // History is best-effort; a failure here shouldn't interrupt the flow.
  }
}
