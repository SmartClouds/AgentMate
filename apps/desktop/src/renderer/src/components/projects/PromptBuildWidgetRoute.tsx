import type { PromptType, TargetAI } from '@runova/core';
import { cliIdForTargetAI, PROMPT_TYPES, TARGET_AIS } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { cliOptionIcon } from '@/components/cliLogos';
import { GrammarTextarea } from '@/components/grammar/GrammarTextarea';
import { Check, Copy, Languages, Sparkles, Spinner, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  commandForEvent,
  useShortcutLabel,
  useShortcutLabelList,
  useShortcutStore,
} from '@/stores/shortcutStore';
import { useProjectPromptBuilder } from './useProjectPromptBuilder';

/**
 * Standalone render target for a pinned Build Prompt desktop widget (loaded
 * at #/widget/prompt-build/:id). No AppShell/sidebar; a transparent page with
 * a frosted-glass card, an OS-drag strip, and a close button. This is the widget's
 * small (non-maximized) layout only, it can't be enlarged back into a dialog.
 */
export default function PromptBuildWidgetRoute(): React.JSX.Element {
  const { id = '' } = useParams();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-widget', '');
    return () => document.documentElement.removeAttribute('data-widget');
  }, []);

  const instanceQuery = useQuery({
    queryKey: ['prompt-build-widget-instance', id],
    queryFn: () => window.runova.promptBuildWidget.getWidget(id),
  });

  const instance = instanceQuery.data ?? null;
  const projectId = instance?.projectId ?? '';

  const {
    rawInput,
    setRawInput,
    promptType,
    setPromptType,
    targetAI,
    setTargetAI,
    generated,
    setGenerated,
    isGenerating,
    isTranslating,
    handleGenerate,
    handleTranslate,
    handleCancel,
    handleCopy,
    saveDraftMutation,
  } = useProjectPromptBuilder(projectId, { enabled: !!projectId });

  const hasRequest = rawInput.trim().length > 0;
  const isBusy = isGenerating || isTranslating;
  const overrides = useShortcutStore((s) => s.overrides);
  const generateKeys = useShortcutLabelList('prompt.generate');
  const translateKey = useShortcutLabel('prompt.translate');
  const copyKey = useShortcutLabel('prompt.copy');

  async function onCopy(): Promise<void> {
    await handleCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="glass-opaque flex h-screen w-screen flex-col overflow-hidden rounded-2xl">
      <div className="widget-drag flex h-7 shrink-0 items-center justify-between px-2.5">
        <span className="truncate pl-1 text-xs font-medium text-muted-foreground/80">
          {instance ? `Build Prompt · ${instance.projectName}` : 'Build Prompt'}
        </span>
        <SimpleTooltip label="Close widget" side="bottom">
          <button
            className="widget-no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground"
            onClick={() => void window.runova.promptBuildWidget.closeWidget(id)}
          >
            <X className="h-3 w-3" />
          </button>
        </SimpleTooltip>
      </div>

      {instance ? (
        <div
          className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden px-3 pb-3"
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
        >
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="widget-prompt-request">Your request</Label>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {rawInput.length === 0 ? '' : `${rawInput.length}`}
              </span>
            </div>
            <div className="relative min-h-0 flex-1">
              <GrammarTextarea
                id="widget-prompt-request"
                containerClassName="absolute inset-0"
                className="h-full min-h-0 w-full resize-none text-sm"
                placeholder="e.g. Add a login form with email/password validation…"
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
              />
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Type</Label>
              <Combobox
                className="h-8"
                value={promptType}
                onChange={(v) => setPromptType(v as PromptType)}
                options={PROMPT_TYPES.map((type) => ({ value: type, label: type }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Target</Label>
              <Combobox
                className="h-8"
                value={targetAI}
                onChange={(v) => setTargetAI(v as TargetAI)}
                options={TARGET_AIS.map((ai) => ({
                  value: ai,
                  label: ai,
                  icon: cliOptionIcon(cliIdForTargetAI(ai)),
                }))}
              />
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <SimpleTooltip label={generateKeys ?? 'Generate'} wrapTrigger={!hasRequest || isBusy}>
              <Button
                onClick={() => void handleGenerate()}
                disabled={!hasRequest || isBusy}
                className="flex-1"
              >
                {isGenerating ? <Spinner className="animate-spin" /> : <Sparkles />}
                {isGenerating ? 'Generating…' : 'Generate'}
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
                {isTranslating ? '…' : 'Translate'}
              </Button>
            </SimpleTooltip>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="widget-prompt-output">Generated prompt</Label>
              <SimpleTooltip
                label={copied ? 'Copied' : copyKey ? `Copy prompt (${copyKey})` : 'Copy prompt'}
                wrapTrigger={!generated || isBusy}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px]"
                  disabled={!generated || isBusy}
                  onClick={() => void onCopy()}
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-primary" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </SimpleTooltip>
            </div>
            <div className="relative min-h-0 flex-1">
              <Textarea
                id="widget-prompt-output"
                value={generated}
                onChange={(e) => setGenerated(e.target.value)}
                placeholder="Generate or translate to fill this."
                className="absolute inset-0 min-h-0 resize-none font-mono text-xs leading-relaxed"
                aria-busy={isBusy}
              />
              {isBusy && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[calc(var(--radius)+6px)] bg-background/70 backdrop-blur-[2px]">
                  <Spinner className="h-4 w-4 animate-spin text-primary" />
                  <Button
                    type="button"
                    variant="soft"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={handleCancel}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </div>

          <Button
            className="w-full shrink-0"
            disabled={!generated || saveDraftMutation.isPending}
            onClick={() => saveDraftMutation.mutate()}
          >
            {saveDraftMutation.isPending ? 'Saving…' : 'Save draft'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
          {instanceQuery.isLoading ? 'Loading…' : 'This widget’s project could not be found.'}
        </div>
      )}
    </div>
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
