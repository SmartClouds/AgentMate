import {
  CLI_REGISTRY,
  COMMIT_MESSAGE_STYLES,
  type CommitMessageSettings,
  DEFAULT_COMMIT_MESSAGE_SETTINGS,
} from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { cliOptionIcon } from '@/components/cliLogos';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/**
 * How AI commit messages get written: which CLI writes them, the style, and any rules of the
 * user's own. Used by the Workspace changes panel (and the project Git tab).
 */
export function CommitMessageSettingsForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const saved = settingsQuery.data?.commitMessage ?? DEFAULT_COMMIT_MESSAGE_SETTINGS;
  const [draft, setDraft] = useState<CommitMessageSettings>(saved);
  const [instructions, setInstructions] = useState(saved.instructions);

  // Follow the stored value when it loads or changes elsewhere.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the saved object
  useEffect(() => {
    setDraft(saved);
    setInstructions(saved.instructions);
  }, [settingsQuery.data?.commitMessage]);

  const mutation = useMutation({
    mutationFn: (next: CommitMessageSettings) =>
      window.runova.settings.update({ commitMessage: next }),
    meta: { silentLoading: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  function save(patch: Partial<CommitMessageSettings>): void {
    const next = { ...draft, ...patch };
    setDraft(next);
    mutation.mutate(next);
  }

  // Instructions save once typing pauses, so each keystroke does not write the settings file.
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounced on the text alone
  useEffect(() => {
    if (instructions === draft.instructions) return;
    const timer = setTimeout(() => save({ instructions }), 600);
    return () => clearTimeout(timer);
  }, [instructions]);

  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Written by</Label>
          <Combobox
            value={draft.cliId ?? ''}
            onChange={(value) => save({ cliId: value || null })}
            placeholder="Project's CLI, then the default"
            searchPlaceholder="Search CLIs…"
            clearable
            options={CLI_REGISTRY.filter((cli) => cli.promptCommand).map((cli) => ({
              value: cli.id,
              label: cli.name,
              icon: cliOptionIcon(cli.id),
            }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Longest summary line</Label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={40}
              max={120}
              step={2}
              value={draft.maxSubjectLength}
              onChange={(event) =>
                setDraft({ ...draft, maxSubjectLength: Number(event.target.value) })
              }
              onPointerUp={() => save({ maxSubjectLength: draft.maxSubjectLength })}
              onKeyUp={() => save({ maxSubjectLength: draft.maxSubjectLength })}
              className="settings-range flex-1"
              aria-label="Longest summary line in characters"
            />
            <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
              {draft.maxSubjectLength} chars
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Style</Label>
        <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
          {COMMIT_MESSAGE_STYLES.map((style) => {
            const selected = draft.style === style.value;
            return (
              <button
                key={style.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => save({ style: style.value })}
                className={cn(
                  'flex flex-col rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'border-primary/50 bg-primary/[0.07]'
                    : 'border-border/70 hover:border-foreground/25',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                      selected ? 'border-primary' : 'border-muted-foreground/50',
                    )}
                  >
                    {selected ? <span className="h-1.5 w-1.5 rounded-full bg-primary" /> : null}
                  </span>
                  {style.label}
                </span>
                <span className="mt-0.5 block pl-5.5 text-xs text-muted-foreground">
                  {style.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="commit-message-instructions" className="text-xs text-muted-foreground">
          {draft.style === 'custom' ? 'Your instructions' : 'Extra instructions (optional)'}
        </Label>
        <Textarea
          id="commit-message-instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={3}
          placeholder={
            draft.style === 'custom'
              ? 'e.g. Start with the ticket id from the branch name, then a short summary.'
              : 'e.g. Mention the ticket id from the branch name. Write in English.'
          }
          className="resize-y text-sm"
        />
      </div>

      {draft.style !== 'detailed' ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">Allow a body</p>
            <p className="text-xs text-muted-foreground">
              A short explanation under the summary when the change needs one.
            </p>
          </div>
          <Switch
            checked={draft.includeBody}
            onCheckedChange={(checked) => save({ includeBody: checked })}
            aria-label="Allow a body under the summary line"
          />
        </div>
      ) : null}
    </div>
  );
}
