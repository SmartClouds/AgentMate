import type { BlueprintStepId, Project } from '@runova/core';
import { blueprintStep } from '@runova/core';
import { useState } from 'react';
import { ArrowLeft, ArrowRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { BlueprintRelayBanner } from './BlueprintRelayBanner';
import { BlueprintReviewStep } from './BlueprintReviewStep';
import { BlueprintRevisionsDialog } from './BlueprintRevisionsDialog';
import { BlueprintStepEditor } from './BlueprintStepEditor';
import { BlueprintStepRail } from './BlueprintStepRail';
import { useProjectBlueprint } from './useBlueprint';
import type { BlueprintWizardStep } from './wizardSteps';
import { BLUEPRINT_WIZARD_STEPS, wizardStepIndex } from './wizardSteps';

/**
 * The Blueprint wizard, as a section of the project page rather than a dialog.
 * It holds long text, attachments and a revision history, and it gets reopened
 * for the life of the project, none of which belongs behind a modal.
 */
export function BlueprintTab({ project }: { project: Project }): React.JSX.Element {
  const [step, setStep] = useState<BlueprintWizardStep>('idea');
  const [historyFor, setHistoryFor] = useState<BlueprintStepId | null | undefined>(undefined);
  const {
    blueprint,
    isLoading,
    presets,
    agentFile,
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
    generate,
    cancelGenerate,
    generateStage,
  } = useProjectBlueprint(project);

  if (isLoading || !blueprint) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const filled = new Set<BlueprintWizardStep>(
    blueprint.sections
      .filter((section) => section.text.trim().length > 0)
      .map((section) => section.stepId),
  );
  if (blueprint.finalPrompt.trim()) filled.add('review');

  const index = wizardStepIndex(step);
  const previous = BLUEPRINT_WIZARD_STEPS[index - 1];
  const next = BLUEPRINT_WIZARD_STEPS[index + 1];
  const section =
    step === 'review' ? null : blueprint.sections.find((entry) => entry.stepId === step);

  const historyOpen = historyFor !== undefined;
  const historyLabel =
    historyFor === null
      ? 'Product Manager prompt'
      : historyFor
        ? blueprintStep(historyFor).heading
        : '';

  return (
    <div className="space-y-2">
      <BlueprintRelayBanner projectId={project.id} />
      <BlueprintStepRail step={step} filled={filled} onSelect={setStep} />

      <div className="glass rounded-[calc(var(--radius)+2px)] p-4">
        {step === 'review' || !section ? (
          <BlueprintReviewStep
            project={project}
            blueprint={blueprint}
            generateStage={generateStage}
            onGenerate={generate}
            onCancelGenerate={cancelGenerate}
            onSavePrompt={(text) => saveFinalPrompt.mutate(text)}
            onDocsFolderChange={(folder) => setDocsFolder.mutate(folder)}
            onConfirmBeforeWritingChange={(value) => setConfirmBeforeWriting.mutate(value)}
            onRelayChange={(value) => setRelay.mutate(value)}
            onOpenHistory={() => setHistoryFor(null)}
            savingPrompt={saveFinalPrompt.isPending}
          />
        ) : (
          <BlueprintStepEditor
            projectId={project.id}
            stepId={section.stepId}
            section={section}
            presets={presets}
            agentFile={agentFile}
            onSave={(text) => saveSection.mutate({ stepId: section.stepId, text })}
            onToggleInclude={(value) =>
              setIncludeInAgentFile.mutate({ stepId: section.stepId, value })
            }
            onPickAttachments={(stepId) => pickAttachments.mutate(stepId)}
            onAddAttachment={(displayName, dataUrl) =>
              addAttachment.mutate({ stepId: section.stepId, displayName, dataUrl })
            }
            onRenameAttachment={(attachmentId, displayName) =>
              renameAttachment.mutate({ stepId: section.stepId, attachmentId, displayName })
            }
            onRemoveAttachment={(attachmentId) =>
              removeAttachment.mutate({ stepId: section.stepId, attachmentId })
            }
            onOpenHistory={() => setHistoryFor(section.stepId)}
            pendingInserts={pendingInserts}
            onInsertsHandled={clearPendingInserts}
            busy={pickAttachments.isPending || addAttachment.isPending}
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-3">
        <Button
          variant="ghost"
          disabled={!previous}
          onClick={() => previous && setStep(previous.id)}
        >
          <ArrowLeft /> {previous ? previous.label : 'Back'}
        </Button>
        <p className="hidden text-xs text-muted-foreground sm:block">
          Steps save on their own. Come back and edit any of them later.
        </p>
        <Button disabled={!next} onClick={() => next && setStep(next.id)}>
          {next ? next.label : 'Done'} <ArrowRight />
        </Button>
      </div>

      <BlueprintRevisionsDialog
        projectId={project.id}
        stepId={historyFor ?? null}
        label={historyLabel}
        open={historyOpen}
        onOpenChange={(open) => {
          if (!open) setHistoryFor(undefined);
        }}
        onRestore={(text) => {
          if (historyFor === null) saveFinalPrompt.mutate(text);
          else if (historyFor) saveSection.mutate({ stepId: historyFor, text });
          setHistoryFor(undefined);
        }}
        restoring={saveSection.isPending || saveFinalPrompt.isPending}
      />
    </div>
  );
}
