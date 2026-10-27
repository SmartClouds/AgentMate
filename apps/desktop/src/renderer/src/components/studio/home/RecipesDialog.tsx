import { styleById } from '@runova/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { runLabel } from '../ai/runSettings';
import { studioAiClient } from '../client';
import { DIALOG_BODY, errorMessage, formatWhen, scriptClass } from '../format';
import {
  Bookmark,
  Button,
  Chip,
  cn,
  confirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  LoadFailure,
  SimpleTooltip,
  Skeleton,
  Trash2,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { ASPECT_LABELS } from './NewVideoDialog';

export interface RecipesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Starts a new video from the recipe, at one of its saves when `version` is given. */
  onUse: (recipeId: string, version?: number) => void;
}

/** The saved recipes: how earlier videos were made, ready to start the next one the same way. */
export function RecipesDialog({
  open,
  onOpenChange,
  onUse,
}: RecipesDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const versions = useQuery({
    queryKey: ['studio', 'recipe-versions', expanded],
    queryFn: () => studioAiClient().recipeVersions(expanded as string),
    enabled: open && expanded !== null,
  });
  const recipes = useQuery({
    queryKey: studioKeys.recipes,
    queryFn: () => studioAiClient().recipes(),
    enabled: open,
  });

  async function exportRecipe(id: string) {
    try {
      const file = await studioAiClient().exportRecipe(id);
      if (file) toast.success(`Saved the recipe to ${file}.`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function importRecipe() {
    try {
      const recipe = await studioAiClient().importRecipe();
      if (!recipe) return;
      await queryClient.invalidateQueries({ queryKey: studioKeys.recipes });
      toast.success(`Added "${recipe.name}" with its ${recipe.versions} saved versions.`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function remove(id: string, name: string) {
    const ok = await confirmDialog({
      title: `Delete the recipe "${name}"?`,
      description: 'Videos made from it keep everything; only the saved recipe goes.',
      confirmLabel: 'Delete recipe',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await studioAiClient().deleteRecipe(id);
      await queryClient.invalidateQueries({ queryKey: studioKeys.recipes });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] max-w-xl">
        <DialogHeader>
          <DialogTitle>Recipes</DialogTitle>
          <DialogDescription>
            Save one from a video's AI runs in its History panel. A new video can start from any of
            them, at any of their saves.
          </DialogDescription>
        </DialogHeader>
        <div className={cn(DIALOG_BODY, 'space-y-4')}>
          <div className="flex justify-end">
            <Button size="sm" variant="soft" onClick={() => void importRecipe()}>
              Import a recipe file
            </Button>
          </div>
          {recipes.isPending && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}
          {recipes.error && (
            <LoadFailure
              message={`The recipes did not load. ${errorMessage(recipes.error)}`}
              retry={() => void recipes.refetch()}
            />
          )}
          {recipes.data?.length === 0 && (
            <EmptyState
              size="sm"
              icon={Bookmark}
              title="No recipes yet"
              description="After the AI writes a scenario you like, choose Save as recipe on that run."
            />
          )}
          <ul className="space-y-1">
            {recipes.data?.map((recipe) => (
              <li
                key={recipe.id}
                aria-label={recipe.name}
                className="flex flex-wrap items-start gap-2 rounded-lg px-2 py-2 hover:bg-foreground/[0.04]"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium" dir="auto">
                    {recipe.name}
                    {recipe.versions > 1 && <Chip tone="neutral">Version {recipe.version}</Chip>}
                  </p>
                  <p
                    className={cn(
                      'line-clamp-2 text-xs text-muted-foreground',
                      scriptClass(recipe.brief),
                    )}
                    dir="auto"
                  >
                    {recipe.brief}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {[
                      ASPECT_LABELS[recipe.aspect],
                      `${recipe.targetSeconds} s`,
                      styleById(recipe.styleId)?.name,
                      runLabel(recipe.scenario),
                      `saved ${formatWhen(recipe.updatedAt)}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => onUse(recipe.id)}>
                  Use
                </Button>
                {recipe.versions > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={expanded === recipe.id}
                    onClick={() => setExpanded((id) => (id === recipe.id ? null : recipe.id))}
                  >
                    Versions
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void exportRecipe(recipe.id)}>
                  Export
                </Button>
                <SimpleTooltip label="Delete this recipe">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${recipe.name}`}
                    onClick={() => void remove(recipe.id, recipe.name)}
                  >
                    <Trash2 />
                  </Button>
                </SimpleTooltip>
                {expanded === recipe.id && (
                  <ul aria-label={`Versions of ${recipe.name}`} className="w-full space-y-1 pl-2">
                    {(versions.data ?? []).map((v) => (
                      <li key={v.version} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 text-muted-foreground">
                          Version {v.version}, saved {formatWhen(v.updatedAt)}: {v.targetSeconds} s,{' '}
                          {runLabel(v.scenario)}
                          {v.voiceRef ? `, voice ${v.voiceRef}` : ''}
                        </span>
                        <Button
                          size="xs"
                          variant="soft"
                          aria-label={`Use version ${v.version}`}
                          onClick={() => onUse(recipe.id, v.version)}
                        >
                          Use
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
