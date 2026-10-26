import type { GenerationView, StudioDocument } from '@agentmat/studio';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { studioAiClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Notice,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { runLabel, savedStageRuns } from './runSettings';

const NEW = '__new__';

export interface SaveRecipeDialogProps {
  /** The scenario run to save the method of; null keeps the dialog closed. */
  generation: GenerationView | null;
  document: StudioDocument;
  onOpenChange: (open: boolean) => void;
}

/**
 * Keeps how a video was made (the brief, style, language, format, length and AI picks) as a
 * recipe, so the next video can start the same way from the New video dialog.
 */
export function SaveRecipeDialog({
  generation,
  document,
  onOpenChange,
}: SaveRecipeDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const nameId = useId();
  const [name, setName] = useState('');
  const [target, setTarget] = useState(NEW);
  useEffect(() => {
    if (!generation) return;
    setName(document.title);
    setTarget(NEW);
  }, [generation, document.title]);
  const recipes = useQuery({
    queryKey: studioKeys.recipes,
    queryFn: () => studioAiClient().recipes(),
    enabled: generation !== null,
  });

  const save = useMutation({
    mutationFn: (g: GenerationView) =>
      studioAiClient().saveRecipe({
        ...(target === NEW ? {} : { id: target }),
        name: name.trim(),
        brief: g.instruction,
        styleId: g.params.styleId ?? null,
        language: document.language,
        aspect: document.renderSettings.aspect,
        targetSeconds: g.params.targetSeconds ?? 60,
        scenario: { cliId: g.cliId, model: g.model, effort: g.effort },
        // The rest of the method (E39): the other stages' picks, the voice and the render.
        stages: savedStageRuns(),
        voiceRef:
          document.scenario.scenes.find((s) => s.voiceRef && s.voiceRef !== 'recording')
            ?.voiceRef ?? null,
        render: {
          resolution: document.renderSettings.resolution,
          fps: document.renderSettings.fps,
          quality: document.renderSettings.quality,
          codec: document.renderSettings.codec,
        },
      }),
    onSuccess: (recipe) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.recipes });
      toast.success(
        recipe.version > 1
          ? `Saved version ${recipe.version} of "${recipe.name}". Earlier versions are kept.`
          : `Saved "${recipe.name}". Pick it in New video to start from it.`,
      );
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={generation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save as recipe</DialogTitle>
          <DialogDescription>
            The brief, style, language, format, length, voice, render choices and{' '}
            {generation ? runLabel(generation) : 'AI'} (with the other stages' picks) are kept, so a
            new video can start the same way.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (generation && name.trim()) save.mutate(generation);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={nameId}>Recipe name</Label>
            <Input
              id={nameId}
              value={name}
              dir="auto"
              autoFocus
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {(recipes.data?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor={`${nameId}-as`}>Save as</Label>
              <Combobox
                id={`${nameId}-as`}
                ariaLabel="Save as"
                searchable={false}
                value={target}
                onChange={(value) => {
                  setTarget(value);
                  const existing = recipes.data?.find((r) => r.id === value);
                  if (existing) setName(existing.name);
                }}
                options={[
                  { value: NEW, label: 'A new recipe' },
                  ...(recipes.data ?? []).map((r) => ({
                    value: r.id,
                    label: `A new version of ${r.name}`,
                  })),
                ]}
              />
            </div>
          )}
          {save.error && (
            <Notice tone="destructive" size="sm">
              {errorMessage(save.error)}
            </Notice>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {save.isPending ? 'Saving...' : 'Save recipe'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
