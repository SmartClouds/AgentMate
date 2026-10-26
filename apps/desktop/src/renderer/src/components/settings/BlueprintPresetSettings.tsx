import type { BlueprintPreset, BlueprintStepId } from '@runova/core';
import { BLUEPRINT_STEPS } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Pencil, Plus, Spinner, Trash2, X } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';

const STEP_OPTIONS = BLUEPRINT_STEPS.map((step) => ({
  value: step.id,
  label: step.label,
  keywords: [step.hint],
}));

/**
 * Presets are grouped by step and shown one group at a time. Six groups laid out
 * at once would be a page of its own inside a settings card, and picking the step
 * is what the user is doing anyway before they add one.
 */
export function BlueprintPresetSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [stepId, setStepId] = useState<BlueprintStepId>('frontend');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');

  const presetsQuery = useQuery({
    queryKey: queryKeys.blueprintPresets,
    queryFn: () => window.runova.blueprints.listPresets(),
  });

  const presets = (presetsQuery.data ?? []).filter((preset) => preset.stepId === stepId);
  const isEditing = editingId !== null;
  const canSave = label.trim().length > 0 && text.trim().length > 0;

  function resetForm(): void {
    setEditingId(null);
    setLabel('');
    setText('');
  }

  function onCache(next: BlueprintPreset[]): void {
    queryClient.setQueryData(queryKeys.blueprintPresets, next);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      window.runova.blueprints.savePreset({
        id: editingId ?? undefined,
        stepId,
        label: label.trim(),
        text: text.trim(),
      }),
    onSuccess: (next) => {
      onCache(next);
      toast.success(isEditing ? 'Preset updated.' : 'Preset added.');
      resetForm();
    },
    onError: (error: Error) => toast.error(error.message || 'Could not save that preset.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (presetId: string) => window.runova.blueprints.deletePreset(presetId),
    onSuccess: (next) => {
      onCache(next);
      toast.success('Preset removed.');
    },
    onError: () => toast.error('Could not remove that preset.'),
  });

  function startEdit(preset: BlueprintPreset): void {
    setEditingId(preset.id);
    setLabel(preset.label);
    setText(preset.text);
  }

  async function handleDelete(preset: BlueprintPreset): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove "${preset.label}"?`,
      description: 'The preset goes for good. Blueprints that already used it keep their text.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!confirmed) return;
    if (editingId === preset.id) resetForm();
    deleteMutation.mutate(preset.id);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Step</Label>
          <Combobox
            className="h-9 w-[12rem]"
            value={stepId}
            onChange={(value) => {
              setStepId(value as BlueprintStepId);
              resetForm();
            }}
            options={STEP_OPTIONS}
          />
        </div>
        <Badge variant="secondary" className="mb-2 font-normal">
          {presets.length} {presets.length === 1 ? 'preset' : 'presets'}
        </Badge>
      </div>

      <div className="space-y-2">
        {presetsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading presets…</p>
        ) : presets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            No presets for this step yet. Add one below and it shows up as a chip in the wizard.
          </p>
        ) : (
          presets.map((preset) => (
            <div
              key={preset.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate text-sm font-medium">{preset.label}</p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{preset.text}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <SimpleTooltip label="Edit">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${preset.label}`}
                    onClick={() => startEdit(preset)}
                  >
                    <Pencil />
                  </Button>
                </SimpleTooltip>
                <SimpleTooltip label="Remove">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Remove ${preset.label}`}
                    onClick={() => void handleDelete(preset)}
                  >
                    <Trash2 />
                  </Button>
                </SimpleTooltip>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            {isEditing ? 'Edit preset' : 'New preset'}
          </Label>
          {isEditing ? (
            <Button variant="soft" size="sm" onClick={resetForm}>
              <X className="h-3 w-3" /> Cancel
            </Button>
          ) : null}
        </div>
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Chip text, e.g. React 19 + Vite + Tailwind"
          maxLength={60}
        />
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What gets appended to the step when the chip is clicked."
          className="min-h-24"
        />
        <Button disabled={!canSave || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          {saveMutation.isPending ? (
            <Spinner className="animate-spin" />
          ) : isEditing ? (
            <Check />
          ) : (
            <Plus />
          )}
          {isEditing ? 'Save changes' : 'Add preset'}
        </Button>
      </div>
    </div>
  );
}
