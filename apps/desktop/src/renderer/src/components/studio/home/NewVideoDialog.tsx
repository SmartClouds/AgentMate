import {
  ASPECTS,
  type Aspect,
  CONTENT_LANGUAGES,
  type RecipeView,
  UNTITLED_TITLE,
  type VideoSummary,
} from '@runova/studio';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { BriefFields, type BriefValue } from '../ai/BriefFields';
import {
  fromRunInput,
  toRunInput,
  usePendingRecipe,
  usePendingScenario,
  useRunSettings,
  writeRunSettings,
} from '../ai/runSettings';
import { listProjects, studioAiClient, studioClient } from '../client';
import { DIALOG_BODY, errorMessage } from '../format';
import {
  appQueryKeys,
  Button,
  Combobox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Notice,
  SEGMENT_TRACK,
  Switch,
  segmentClass,
} from '../kit';
import { studioKeys } from '../queryKeys';

/** The format picker's words for each aspect ratio. */
export const ASPECT_LABELS: Record<Aspect, string> = {
  '16:9': 'Landscape 16:9',
  '9:16': 'Vertical 9:16',
  '1:1': 'Square 1:1',
  '4:5': 'Portrait 4:5',
};

const STANDALONE = '__standalone__';
const BLANK = '__blank__';

export interface NewVideoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselects a project (from a project's Studio tab), or standalone with null. */
  projectId?: string | null;
  /** Starts from a saved recipe. */
  recipeId?: string | null;
  /** One of the recipe's earlier saves; its latest when left out. */
  recipeVersion?: number | null;
  onCreated: (video: VideoSummary) => void;
}

/**
 * A new video: where it belongs, its language and format, and usually the brief the AI writes the
 * scenario from. A saved recipe fills all of that in. The scenario run starts once the editor has
 * the video open, so the user watches it there.
 */
export function NewVideoDialog({
  open,
  onOpenChange,
  projectId = null,
  recipeId = null,
  recipeVersion = null,
  onCreated,
}: NewVideoDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const titleId = useId();
  const aiId = useId();
  const [savedRun, setSavedRun] = useRunSettings('scenario');
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState(projectId ?? STANDALONE);
  const [language, setLanguage] = useState('fa');
  const [aspect, setAspect] = useState<Aspect>('16:9');
  const [recipe, setRecipe] = useState(BLANK);
  const [picked, setPicked] = useState<RecipeView | null>(null);
  const [useAi, setUseAi] = useState(true);
  const [brief, setBrief] = useState<BriefValue>({
    brief: '',
    targetSeconds: 60,
    styleId: null,
    run: savedRun,
  });

  const recipes = useQuery({
    queryKey: studioKeys.recipes,
    queryFn: () => studioAiClient().recipes(),
    enabled: open,
  });

  const applyRecipe = (picked: RecipeView | undefined) => {
    setRecipe(picked?.id ?? BLANK);
    setPicked(picked ?? null);
    if (!picked) return;
    setLanguage(picked.language);
    setAspect(picked.aspect);
    setUseAi(true);
    setBrief({
      brief: picked.brief,
      targetSeconds: picked.targetSeconds,
      styleId: picked.styleId,
      run: fromRunInput(picked.scenario),
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: resets only when the dialog opens
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setOwner(projectId ?? STANDALONE);
    setRecipe(BLANK);
    setBrief((current) => ({ ...current, brief: '', run: savedRun }));
  }, [open, projectId]);

  // A recipe chosen from the Recipes list arrives once the saved recipes have loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyRecipe only sets state
  useEffect(() => {
    if (!open || !recipeId) return;
    if (recipeVersion === null) {
      applyRecipe(recipes.data?.find((r) => r.id === recipeId));
      return;
    }
    void studioAiClient()
      .recipeVersion(recipeId, recipeVersion)
      .then(applyRecipe)
      .catch(() => undefined);
  }, [open, recipeId, recipeVersion, recipes.data]);

  const projects = useQuery({
    queryKey: appQueryKeys.projects,
    queryFn: listProjects,
    enabled: open,
  });
  const chosenProject = owner === STANDALONE ? null : owner;
  const storage = useQuery({
    queryKey: studioKeys.projectStorage(chosenProject ?? ''),
    queryFn: () => studioClient().projectStorage(chosenProject as string),
    enabled: open && chosenProject !== null,
  });
  const settings = useQuery({
    queryKey: studioKeys.settings,
    queryFn: () => studioClient().settings(),
    enabled: open && chosenProject === null,
  });

  const create = useMutation({
    mutationFn: () =>
      studioClient().create({
        title: title.trim() || UNTITLED_TITLE,
        projectId: chosenProject,
        language,
        aspect,
      }),
    onSuccess: (video) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.videos });
      // Every stage choice the recipe kept, not only the scenario's (E39).
      if (picked && recipe === picked.id) {
        if (picked.stages?.edit) writeRunSettings('edit', fromRunInput(picked.stages.edit));
        if (picked.stages?.scene) writeRunSettings('scene', fromRunInput(picked.stages.scene));
        usePendingRecipe.getState().set(video.id, {
          name: picked.name,
          render: picked.render ?? null,
          voiceRef: picked.voiceRef ?? null,
        });
      }
      if (useAi) {
        setSavedRun(brief.run);
        usePendingScenario.getState().set(video.id, {
          brief: brief.brief.trim(),
          targetSeconds: brief.targetSeconds,
          styleId: brief.styleId,
          run: toRunInput(brief.run),
        });
      }
      onOpenChange(false);
      onCreated(video);
    },
  });

  const owners = [
    { value: STANDALONE, label: 'Standalone video (no project)' },
    ...(projects.data ?? [])
      .filter((p) => !p.archived)
      .map((p) => ({ value: p.id, label: p.name })),
  ];
  const languages = CONTENT_LANGUAGES.map((l) => ({
    value: l.code,
    label: l.native === l.name ? l.name : `${l.name} (${l.native})`,
    keywords: [l.native, l.code],
  }));
  const recipeOptions = [
    { value: BLANK, label: 'A blank video' },
    ...(recipes.data ?? []).map((r) => ({ value: r.id, label: r.name, keywords: [r.brief] })),
  ];
  const where = chosenProject ? storage.data?.root : settings.data?.standaloneRoot;
  const blocked = chosenProject !== null && storage.data?.check.ok === false;
  const ready = useAi ? brief.brief.trim().length > 0 : title.trim().length > 0;
  const error = create.error ? errorMessage(create.error) : null;
  const submit = () => {
    if (ready && !blocked && !create.isPending) create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New video</DialogTitle>
          <DialogDescription>
            Choose its language and format, and tell the AI what it is about. You can edit the
            scenario it writes, or write one yourself.
          </DialogDescription>
        </DialogHeader>
        {/* The form adds no box of its own, so the fields scroll in the dialog's middle row
            while the buttons stay in view below them. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className={cn(DIALOG_BODY, 'space-y-4')}>
            {(recipes.data?.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <Label>Start from</Label>
                <Combobox
                  ariaLabel="Start from"
                  options={recipeOptions}
                  value={recipe}
                  onChange={(id) => applyRecipe(recipes.data?.find((r) => r.id === id))}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={titleId}>Title</Label>
              <Input
                id={titleId}
                value={title}
                dir="auto"
                autoFocus
                maxLength={200}
                placeholder={useAi ? 'Leave empty and the AI names it' : 'Product launch teaser'}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Belongs to</Label>
                <Combobox
                  ariaLabel="Belongs to"
                  options={owners}
                  value={owner}
                  onChange={setOwner}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Language</Label>
                <Combobox
                  ariaLabel="Language"
                  options={languages}
                  value={language}
                  onChange={setLanguage}
                />
              </div>
            </div>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Format</legend>
              <div className={SEGMENT_TRACK} role="radiogroup" aria-label="Format">
                {ASPECTS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={aspect === value}
                    className={segmentClass(aspect === value)}
                    onClick={() => setAspect(value)}
                  >
                    {ASPECT_LABELS[value]}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="flex items-center gap-2">
              <Switch id={aiId} checked={useAi} onCheckedChange={setUseAi} />
              <Label htmlFor={aiId}>Write the scenario with AI</Label>
            </div>
            {useAi && (
              <BriefFields
                value={brief}
                onChange={setBrief}
                aspect={aspect}
                language={language}
                onSubmit={submit}
              />
            )}
            {where && (
              <p className="text-xs text-muted-foreground">
                Saved in <span className="break-all font-mono">{where}</span>
              </p>
            )}
            {blocked && (
              <Notice tone="destructive" size="sm">
                {storage.data?.check.problems.find((p) => p.level === 'error')?.message} Change the
                folder in the project's Studio tab first.
              </Notice>
            )}
            {error && (
              <Notice tone="destructive" size="sm">
                {error}
              </Notice>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || blocked || create.isPending}>
              {create.isPending ? 'Creating...' : useAi ? 'Create and write' : 'Create video'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
