import type { GenerationView, StudioDocument } from '@agentmat/studio';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { studioAiClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
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
import { runLabel } from './runSettings';

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
  useEffect(() => {
    if (generation) setName(document.title);
  }, [generation, document.title]);

  const save = useMutation({
    mutationFn: (g: GenerationView) =>
      studioAiClient().saveRecipe({
        name: name.trim(),
        brief: g.instruction,
        styleId: g.params.styleId ?? null,
        language: document.language,
        aspect: document.renderSettings.aspect,
        targetSeconds: g.params.targetSeconds ?? 60,
        scenario: { cliId: g.cliId, model: g.model, effort: g.effort },
      }),
    onSuccess: (recipe) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.recipes });
      toast.success(`Saved "${recipe.name}". Pick it in New video to start from it.`);
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={generation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save as recipe</DialogTitle>
          <DialogDescription>
            The brief, style, language, format, length and{' '}
            {generation ? runLabel(generation) : 'AI'} are kept, so a new video can start the same
            way.
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
