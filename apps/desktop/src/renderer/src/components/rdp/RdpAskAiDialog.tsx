import {
  CLI_REGISTRY,
  defaultEffortFor,
  EFFORT_LABELS,
  type EffortLevel,
  runProfileForTargetAI,
  supportsPromptImages,
} from '@runova/core';
import type { SshAgentMode } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CliLogo } from '@/components/cliLogos';
import { Robot } from '@/components/icons';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useCliStore } from '@/stores/cliStore';
import { startRdpAgentTask, useRdpAgentStore } from '@/stores/rdpAgentStore';

const MODES: { value: SshAgentMode; label: string; description: string }[] = [
  {
    value: 'approve-all',
    label: 'Approve each action',
    description: 'Nothing happens on the desktop until you click Approve on it.',
  },
  {
    value: 'approve-risky',
    label: 'Auto, guard risky ones',
    description: 'Ask before shortcuts like Win+R or Alt+F4 and before typing text.',
  },
  {
    value: 'autonomous',
    label: 'Fully autonomous',
    description: 'Runs the whole task unattended. Just watch the desktop.',
  },
];

/** Picker value for the OpenAI/Gemini/Ollama provider set in Settings instead of a CLI. */
const SETTINGS_PROVIDER = '__settings__';
/** Picker value for "let the CLI use whatever model it's configured with". */
const CLI_DEFAULT_MODEL = '__cli-default__';

/** Starts an AI task that works this Remote Desktop session by looking at it and clicking/typing. */
export function RdpAskAiDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const lastMode = useRdpAgentStore((s) => s.lastMode);
  const lastAi = useRdpAgentStore((s) => s.lastAi);
  const defaultCliId = useCliStore((s) => s.defaultCliId);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<SshAgentMode>(lastMode);
  const [cliValue, setCliValue] = useState<string | null>(null);
  const [modelValue, setModelValue] = useState(CLI_DEFAULT_MODEL);
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const [starting, setStarting] = useState(false);

  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    meta: { silentLoading: true },
  });

  // Installed CLIs that can be shown a screenshot in a one-shot prompt.
  const visionClis = CLI_REGISTRY.filter(
    (cli) => supportsPromptImages(cli) && cliQuery.data?.find((c) => c.id === cli.id)?.installed,
  );

  // Seed the pickers once the installed CLIs are known: last run's choice, then the default CLI,
  // then the first one that fits, then Settings' AI provider when none does.
  useEffect(() => {
    if (cliValue !== null || !cliQuery.isFetched) return;
    const usable = (id: string | null | undefined) =>
      !!id && visionClis.some((cli) => cli.id === id);
    if (lastAi && (lastAi.cliId === null || usable(lastAi.cliId))) {
      setCliValue(lastAi.cliId ?? SETTINGS_PROVIDER);
      setModelValue(lastAi.modelId ?? CLI_DEFAULT_MODEL);
      setEffort(lastAi.effort);
      return;
    }
    setCliValue(
      usable(defaultCliId) ? (defaultCliId as string) : (visionClis[0]?.id ?? SETTINGS_PROVIDER),
    );
  }, [cliValue, cliQuery.isFetched, visionClis, lastAi, defaultCliId]);

  const cliId = cliValue && cliValue !== SETTINGS_PROVIDER ? cliValue : null;
  const profile = cliId ? runProfileForTargetAI(cliId) : null;
  // A generic profile only describes models by class, which isn't something a flag can pick.
  const models = profile && !profile.generic ? profile.models : [];
  const model = models.find((m) => m.id === modelValue);
  const efforts = model?.efforts ?? [];

  function selectCli(value: string): void {
    setCliValue(value);
    setModelValue(CLI_DEFAULT_MODEL);
    setEffort(null);
  }

  function selectModel(value: string): void {
    setModelValue(value);
    const next = models.find((m) => m.id === value);
    setEffort(next ? (defaultEffortFor(next) ?? null) : null);
  }

  async function handleStart(): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed || starting || cliValue === null) return;
    setStarting(true);
    try {
      await startRdpAgentTask({
        sessionId,
        prompt: trimmed,
        mode,
        cliId,
        modelId: model?.id ?? null,
        effort: model && effort && efforts.includes(effort) ? effort : null,
      });
      setPrompt('');
      onOpenChange(false);
    } catch (error) {
      toast.error((error as Error).message || 'Could not start the AI task.');
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Robot className="h-4 w-4" />
            Ask AI to do something on this desktop
          </DialogTitle>
          <DialogDescription>
            Describe what you want done. The AI looks at the screen and uses the mouse and keyboard
            one step at a time, and you can take over whenever you like.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Open Notepad and write a shopping list"
            className="min-h-24 resize-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleStart();
              }
            }}
          />

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label className="text-xs">CLI</Label>
              <Combobox
                className="h-8 text-xs"
                value={cliValue ?? ''}
                onChange={selectCli}
                disabled={!cliQuery.isFetched}
                placeholder={cliQuery.isFetched ? 'Choose' : 'Detecting…'}
                searchPlaceholder="Search CLIs…"
                options={[
                  ...visionClis.map((cli) => ({
                    value: cli.id,
                    label: cli.name,
                    icon: <CliLogo cliId={cli.id} className="h-3.5 w-3.5 shrink-0" />,
                  })),
                  {
                    value: SETTINGS_PROVIDER,
                    label: 'AI provider in Settings (needs a model that can see images)',
                  },
                ]}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label className="text-xs">Model</Label>
              <Combobox
                className="h-8 text-xs"
                value={cliId ? modelValue : ''}
                onChange={selectModel}
                disabled={models.length === 0}
                placeholder={cliId ? 'CLI default' : 'From Settings'}
                searchPlaceholder="Search models…"
                options={[
                  { value: CLI_DEFAULT_MODEL, label: 'CLI default' },
                  ...models.map((m) => ({ value: m.id, label: m.label })),
                ]}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label className="text-xs">Effort</Label>
              <Combobox
                className="h-8 text-xs"
                value={effort && efforts.includes(effort) ? effort : ''}
                onChange={(value) => setEffort(value as EffortLevel)}
                disabled={efforts.length === 0}
                placeholder={model ? 'Not adjustable' : 'Default'}
                searchPlaceholder="Search…"
                options={efforts.map((level) => ({ value: level, label: EFFORT_LABELS[level] }))}
              />
            </div>
          </div>
          {cliQuery.isFetched && visionClis.length === 0 && (
            <p className="-mt-1 text-xs text-muted-foreground">
              No installed agent CLI can look at a screenshot, so the AI provider from Settings is
              used, and its model has to be one that can see images. Install Claude Code, Codex, or
              Gemini from CLI Manager to pick one.
            </p>
          )}
          <p className="-mt-1 text-xs text-muted-foreground">
            Screenshots of this desktop are sent to the AI you pick, so it can see what it&apos;s
            doing.
          </p>

          <div className="flex flex-col gap-1.5">
            {MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                className={cn(
                  'flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-xs transition-colors',
                  mode === option.value
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:bg-foreground/5',
                )}
              >
                <span className="font-medium text-foreground">{option.label}</span>
                <span className="text-muted-foreground">{option.description}</span>
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleStart()}
            disabled={!prompt.trim() || starting || cliValue === null}
          >
            {starting ? 'Starting…' : 'Start'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
