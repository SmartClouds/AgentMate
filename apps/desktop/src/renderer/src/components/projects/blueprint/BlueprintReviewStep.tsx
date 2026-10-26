import type { Project, ProjectBlueprint } from '@runova/core';
import { blueprintStep, DEFAULT_RELAY_BUDGET, targetAIForProject } from '@runova/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CliLogo } from '@/components/cliLogos';
import { MarkdownEditor } from '@/components/editor/MarkdownEditor';
import {
  Check,
  ChevronDown,
  Copy,
  History,
  Save,
  Sparkles,
  Spinner,
  StopCircle,
  TerminalSquare,
} from '@/components/icons';
import { BudgetPicker } from '@/components/relay/BudgetPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { FixWithAiDialog } from '@/components/workspace/FixWithAiDialog';
import { queryKeys } from '@/lib/queryKeys';
import { containsPersian, persianTextProps } from '@/lib/rtl';
import type { BlueprintGeneratorChoice } from '@/stores/blueprintGeneratorStore';
import { BlueprintGeneratorFields, useBlueprintGenerator } from './BlueprintGenerator';
import type { GenerateStage } from './useBlueprint';

export function BlueprintReviewStep({
  project,
  blueprint,
  generateStage,
  onGenerate,
  onCancelGenerate,
  onSavePrompt,
  onDocsFolderChange,
  onConfirmBeforeWritingChange,
  onRelayChange,
  onOpenHistory,
  savingPrompt,
}: {
  project: Project;
  blueprint: ProjectBlueprint;
  generateStage: GenerateStage;
  /** Resolves to the saved prompt, or null when nothing was written. */
  onGenerate: (choice: BlueprintGeneratorChoice) => Promise<string | null>;
  onCancelGenerate: () => void;
  onSavePrompt: (text: string) => void;
  onDocsFolderChange: (folder: string) => void;
  onConfirmBeforeWritingChange: (value: boolean) => void;
  /** Relay (E26): write the backlog as task files sized to this context budget. */
  onRelayChange: (value: { enabled: boolean; budgetTokens: number }) => void;
  onOpenHistory: () => void;
  savingPrompt: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(blueprint.finalPrompt);
  const [docsFolder, setDocsFolder] = useState(blueprint.docsFolder);
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  // The run dialog sizes the prompt as soon as it mounts, so it waits for the first opening.
  const [runMounted, setRunMounted] = useState(false);
  const generator = useBlueprintGenerator(project);

  useEffect(() => setPrompt(blueprint.finalPrompt), [blueprint.finalPrompt]);
  useEffect(() => setDocsFolder(blueprint.docsFolder), [blueprint.docsFolder]);

  const busy = generateStage !== 'idle';
  const filled = blueprint.sections.filter((section) => section.text.trim().length > 0);
  const persianSections = filled.filter((section) => containsPersian(section.text));
  const dirty = prompt !== blueprint.finalPrompt;
  const canGenerate = !busy && filled.length > 0 && generator.choice !== null;
  const generateLabel = blueprint.finalPrompt ? 'Regenerate prompt' : 'Generate prompt';
  const runJobKey = `blueprint:${project.id}:${blueprint.finalPromptUpdatedAt ?? 'draft'}`;

  async function copyPrompt(): Promise<void> {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const relay = blueprint.relay ?? { enabled: false, budgetTokens: DEFAULT_RELAY_BUDGET };

  async function openRun(): Promise<void> {
    // The prompt points the agent at the Relay guide, so it has to be in the project first.
    if (relay.enabled) {
      try {
        await window.runova.relay.ensureGuide(project.id, blueprint.docsFolder);
      } catch {
        toast.error('Could not write the Relay guide into the project.', {
          description: 'The agent will not find the task format. Check the docs folder.',
        });
      }
    }
    setRunMounted(true);
    setRunOpen(true);
  }

  async function handleGenerate(): Promise<void> {
    const choice = generator.choice;
    if (!choice || busy) return;
    setPickerOpen(false);
    const hadPrompt = !!blueprint.finalPrompt;
    const written = await onGenerate(choice);
    if (!written) return;
    toast.success(hadPrompt ? 'Prompt regenerated' : 'Prompt ready', {
      description: 'Run it in an agent CLI now, or read it over and edit it first.',
      action: { label: 'Run in CLI', onClick: () => void openRun() },
    });
  }

  async function saveAsDraft(): Promise<void> {
    try {
      await window.runova.projectDrafts.create({
        projectId: project.id,
        rawInput: filled.map((section) => section.text).join('\n\n'),
        promptType: 'Product',
        targetAI: targetAIForProject(project.agentType, project.cliId),
        content: prompt,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectDrafts(project.id) });
      toast.success("Draft saved. It's on the project's Overview tab.");
    } catch {
      toast.error('Could not save the draft.');
    }
  }

  async function setAsStandingPrompt(): Promise<void> {
    try {
      await window.runova.projects.update(project.id, { prompt });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      toast.success('Set as this project’s standing prompt.');
    } catch {
      toast.error('Could not set the standing prompt.');
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="blueprint-docs-folder">Docs folder</Label>
          <Input
            id="blueprint-docs-folder"
            value={docsFolder}
            onChange={(event) => setDocsFolder(event.target.value)}
            onBlur={() => {
              if (docsFolder !== blueprint.docsFolder) onDocsFolderChange(docsFolder);
            }}
            placeholder="docs"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Where the prompt tells the agent to write the plan, relative to the project root.
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
          <Switch
            id="blueprint-confirm"
            checked={blueprint.confirmBeforeWriting}
            onCheckedChange={onConfirmBeforeWritingChange}
          />
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="blueprint-confirm" className="cursor-pointer">
              Confirm before writing files
            </Label>
            <p className="text-xs text-muted-foreground">
              The agent lists the phases and epics it plans to create and waits for a yes.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
        <Switch
          id="blueprint-relay"
          checked={relay.enabled}
          onCheckedChange={(enabled) => onRelayChange({ ...relay, enabled })}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="space-y-0.5">
            <Label htmlFor="blueprint-relay" className="cursor-pointer">
              Split into Relay tasks
            </Label>
            <p className="text-xs text-muted-foreground">
              The backlog becomes task files that each fit one AI session. Runova runs them one
              after another, and every session leaves a handoff for the next.
            </p>
          </div>
          {relay.enabled ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Context per session</span>
              <BudgetPicker
                value={relay.budgetTokens}
                onChange={(budgetTokens) => onRelayChange({ ...relay, budgetTokens })}
              />
            </div>
          ) : null}
        </div>
      </div>

      {persianSections.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">
            {persianSections.length} step{persianSections.length === 1 ? '' : 's'} were written in
            Persian. Generating translates them first, and the prompt comes out in English.
          </p>
          <div className="space-y-2">
            {persianSections.map((section) => (
              <div key={section.stepId} className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-md border border-border bg-background/60 p-2">
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {blueprintStep(section.stepId).heading}
                  </p>
                  <p className="line-clamp-4 text-sm" {...persianTextProps(section.text)}>
                    {section.text}
                  </p>
                </div>
                <div className="rounded-md border border-border bg-background/60 p-2">
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    English
                  </p>
                  <p className="line-clamp-4 text-sm text-muted-foreground">
                    {section.textEn ?? 'Translated when you generate.'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <SimpleTooltip
            label={filled.length === 0 ? 'Fill in at least one step first' : undefined}
            wrapTrigger={filled.length === 0}
          >
            <PopoverAnchor asChild>
              <div className="flex">
                <Button
                  className="rounded-r-none"
                  onClick={() => void handleGenerate()}
                  disabled={!canGenerate}
                >
                  {busy ? <Spinner className="animate-spin" /> : <Sparkles />}
                  {generateStage === 'translating'
                    ? 'Translating…'
                    : generateStage === 'writing'
                      ? `Writing with ${generator.engineName}…`
                      : generateLabel}
                </Button>
                <PopoverTrigger asChild>
                  <Button
                    className="w-8 rounded-l-none border-l border-primary-foreground/20 px-0"
                    disabled={busy || filled.length === 0}
                    aria-label="Choose the model and effort for generating"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
              </div>
            </PopoverAnchor>
          </SimpleTooltip>
          <PopoverContent align="start" className="w-80 p-0">
            <div className="border-b border-border/70 px-3 py-2.5">
              <p className="text-sm font-medium">Generate with</p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Remembered for this project. Change it any time before you generate.
              </p>
            </div>
            <div className="px-3 py-3">
              <BlueprintGeneratorFields generator={generator} />
            </div>
            <div className="border-t border-border/70 px-3 py-2.5">
              <Button
                className="w-full"
                size="sm"
                onClick={() => void handleGenerate()}
                disabled={!canGenerate}
              >
                <Sparkles />
                {generateLabel}
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {busy ? (
          <Button variant="ghost" size="sm" onClick={onCancelGenerate}>
            <StopCircle /> Cancel
          </Button>
        ) : (
          <SimpleTooltip label="Change the model and effort">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPickerOpen(true)}
              disabled={filled.length === 0}
              className="max-w-[18rem] gap-1.5 text-muted-foreground"
            >
              {generator.choice?.cliId ? (
                <CliLogo cliId={generator.choice.cliId} className="h-3.5 w-3.5 shrink-0" />
              ) : null}
              <span className="truncate">{generator.label}</span>
            </Button>
          </SimpleTooltip>
        )}

        <Button variant="ghost" size="sm" onClick={onOpenHistory}>
          <History /> History
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" disabled={!prompt} onClick={() => void copyPrompt()}>
            {copied ? <Check className="text-primary" /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="outline" size="sm" disabled={!prompt} onClick={() => void saveAsDraft()}>
            Save as draft
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!prompt}
            onClick={() => void setAsStandingPrompt()}
          >
            Use as standing prompt
          </Button>
          <SimpleTooltip
            label={
              !prompt
                ? 'Generate a prompt first'
                : dirty
                  ? 'Runs the text in the editor, unsaved edits included'
                  : 'Pick the model and effort, then run it in an agent CLI'
            }
            wrapTrigger={!prompt}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={!prompt || busy}
              onClick={() => void openRun()}
            >
              <TerminalSquare /> Run in CLI
            </Button>
          </SimpleTooltip>
          <Button disabled={!dirty || savingPrompt} onClick={() => onSavePrompt(prompt)}>
            {savingPrompt ? <Spinner className="animate-spin" /> : <Save />}
            Save prompt
          </Button>
        </div>
      </div>

      <MarkdownEditor
        value={prompt}
        onChange={setPrompt}
        onSave={() => onSavePrompt(prompt)}
        defaultHeight={460}
      />

      {/* Keyed by the generated prompt, so a regenerate starts the dialog fresh while closing
          and reopening keeps the sizing and the model the user picked in it. */}
      {runMounted ? (
        <FixWithAiDialog
          key={runJobKey}
          project={project}
          open={runOpen}
          onOpenChange={setRunOpen}
          title="Run the Blueprint prompt"
          description="Pick the model and effort, then the agent opens in a workspace tab with the prompt typed in. Press Enter there to start it."
          jobKey={runJobKey}
          source={{ prompt }}
          promptType="Product"
          promptLabel="Blueprint prompt"
        />
      ) : null}
    </div>
  );
}
