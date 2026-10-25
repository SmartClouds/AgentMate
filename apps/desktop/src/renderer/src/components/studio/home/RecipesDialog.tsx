import { styleById } from '@agentmat/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { runLabel } from '../ai/runSettings';
import { studioAiClient } from '../client';
import { errorMessage, formatWhen, scriptClass } from '../format';
import {
  Bookmark,
  Button,
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
  /** Starts a new video from the recipe. */
  onUse: (recipeId: string) => void;
}

/** The saved recipes: how earlier videos were made, ready to start the next one the same way. */
export function RecipesDialog({
  open,
  onOpenChange,
  onUse,
}: RecipesDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const recipes = useQuery({
    queryKey: studioKeys.recipes,
    queryFn: () => studioAiClient().recipes(),
    enabled: open,
  });

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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Recipes</DialogTitle>
          <DialogDescription>
            Save one from a video's AI runs in its History panel. A new video can start from any of
            them.
          </DialogDescription>
        </DialogHeader>
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
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
          {recipes.data?.map((recipe) => (
            <li
              key={recipe.id}
              className="flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-foreground/[0.04]"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium" dir="auto">
                  {recipe.name}
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
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
