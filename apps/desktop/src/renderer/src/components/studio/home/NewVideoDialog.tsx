import { ASPECTS, type Aspect, CONTENT_LANGUAGES, type VideoSummary } from '@agentmat/studio';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { listProjects, studioClient } from '../client';
import { errorMessage } from '../format';
import {
  appQueryKeys,
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
  SEGMENT_TRACK,
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

export interface NewVideoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselects a project (from a project's Studio tab), or standalone with null. */
  projectId?: string | null;
  onCreated: (video: VideoSummary) => void;
}

export function NewVideoDialog({
  open,
  onOpenChange,
  projectId = null,
  onCreated,
}: NewVideoDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const titleId = useId();
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState(projectId ?? STANDALONE);
  const [language, setLanguage] = useState('fa');
  const [aspect, setAspect] = useState<Aspect>('16:9');

  useEffect(() => {
    if (open) {
      setTitle('');
      setOwner(projectId ?? STANDALONE);
    }
  }, [open, projectId]);

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
      studioClient().create({ title: title.trim(), projectId: chosenProject, language, aspect }),
    onSuccess: (video) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.videos });
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
  const where = chosenProject ? storage.data?.root : settings.data?.standaloneRoot;
  const blocked = chosenProject !== null && storage.data?.check.ok === false;
  const error = create.error ? errorMessage(create.error) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New video</DialogTitle>
          <DialogDescription>
            Name it and choose its language and format. You write the brief and the scenario next.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() && !blocked) create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              value={title}
              dir="auto"
              autoFocus
              maxLength={200}
              placeholder="Product launch teaser"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Belongs to</Label>
            <Combobox ariaLabel="Belongs to" options={owners} value={owner} onChange={setOwner} />
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
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || blocked || create.isPending}>
              {create.isPending ? 'Creating...' : 'Create video'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
