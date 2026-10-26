import type { SkillUsageStat, UsedSkillOrigin } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CircleInfo, FolderPlus, Search } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

const ORIGIN_LABELS: Record<UsedSkillOrigin, string> = {
  project: 'Project',
  global: 'Global',
  plugin: 'Plugin',
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The picker behind a Usage row's "Add to another project" button. It finds where the skill the
 * agent used actually lives, then copies that folder into whichever projects are ticked. Projects
 * that already have a skill of that name stay listed but can't be picked, so nothing is replaced.
 */
function AddUsedSkillContent({
  stat,
  onDone,
}: {
  stat: SkillUsageStat;
  onDone: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const projectPaths = useMemo(() => stat.projects.map((project) => project.path), [stat]);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });

  const inspectionQuery = useQuery({
    queryKey: queryKeys.usedSkillInspection(stat.skill),
    queryFn: () => window.runova.skills.inspectUsedSkill({ skill: stat.skill, projectPaths }),
    staleTime: 0,
  });

  const inspection = inspectionQuery.data;
  const present = useMemo(
    () => new Set(inspection?.presentInProjectIds ?? []),
    [inspection?.presentInProjectIds],
  );

  const projects = useMemo(() => {
    const all = projectsQuery.data ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return all;
    return all.filter(
      (project) =>
        project.name.toLowerCase().includes(query) ||
        project.folderPath.toLowerCase().includes(query),
    );
  }, [projectsQuery.data, search]);

  const addMutation = useMutation({
    mutationFn: (projectIds: string[]) =>
      window.runova.skills.addUsedSkillToProjects({
        skill: stat.skill,
        projectPaths,
        projectIds,
      }),
    onSuccess: (results) => {
      const added = results.filter((result) => result.status === 'added');
      const existing = results.filter((result) => result.status === 'exists');
      const failed = results.filter((result) => result.status === 'failed');

      for (const result of added) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.onDiskSkills(result.projectId) });
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.usedSkillInspection(stat.skill),
      });

      if (added.length > 0) {
        toast.success(`Added ${stat.skill} to ${plural(added.length, 'project')}.`);
      }
      if (existing.length > 0) {
        toast.info(`${plural(existing.length, 'project')} already had ${stat.skill}, left as is.`);
      }
      if (failed.length > 0) {
        toast.error(
          `Could not add ${stat.skill} to ${plural(failed.length, 'project')}.` +
            (failed[0].error ? ` ${failed[0].error}` : ''),
        );
        // Keep only the ones that failed ticked, so a retry doesn't redo the rest.
        setSelected(new Set(failed.map((result) => result.projectId)));
        return;
      }
      onDone();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggle = (projectId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const source = inspection?.source ?? null;
  const canAdd = !!source && selected.size > 0 && !addMutation.isPending;

  return (
    <DialogContent className="flex max-h-[70vh] flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>Add {stat.skill} to projects</DialogTitle>
        <DialogDescription>
          Copies the skill's folder into each project's skills folder, so agents working there can
          use it too.
        </DialogDescription>
      </DialogHeader>

      {inspectionQuery.isPending ? (
        <Skeleton className="h-[52px] w-full rounded-lg" />
      ) : inspectionQuery.isError ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          {inspectionQuery.error.message}
        </p>
      ) : source ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card/60 px-3 py-2.5">
          <Badge variant="secondary" className="shrink-0">
            {ORIGIN_LABELS[source.origin]}
          </Badge>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-foreground">From {source.label}</span>
            <SimpleTooltip label={source.path}>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {source.path}
              </span>
            </SimpleTooltip>
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
          <CircleInfo className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Couldn't find this skill's files on disk. It may be built into the agent, or its folder
            was moved or deleted since it was used.
          </span>
        </div>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 z-10 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Search projects…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="-mx-1 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1 py-0.5">
        {projectsQuery.isPending &&
          Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-[52px] w-full rounded-lg" />
          ))}
        {projects.map((project) => {
          const hasIt = present.has(project.id);
          const checked = !hasIt && selected.has(project.id);
          return (
            <label
              key={project.id}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                hasIt
                  ? 'cursor-default border-border bg-card/30 opacity-70'
                  : checked
                    ? 'cursor-pointer border-primary/60 bg-primary/10'
                    : 'cursor-pointer border-border bg-card/60 hover:bg-card',
              )}
            >
              <Checkbox
                checked={checked}
                disabled={hasIt || inspectionQuery.isPending}
                aria-label={project.name}
                onCheckedChange={() => toggle(project.id)}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
                <span className="truncate text-xs text-muted-foreground">{project.folderPath}</span>
              </span>
              {hasIt && (
                <Badge variant="outline" className="shrink-0">
                  Already has it
                </Badge>
              )}
            </label>
          );
        })}
        {!projectsQuery.isPending && projects.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {(projectsQuery.data?.length ?? 0) === 0
              ? 'No projects yet. Create one first.'
              : 'No projects match your search.'}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button type="button" disabled={!canAdd} onClick={() => addMutation.mutate([...selected])}>
          <FolderPlus />
          {selected.size > 0 ? `Add to ${plural(selected.size, 'project')}` : 'Add'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function AddUsedSkillDialog({
  stat,
  onClose,
}: {
  /** The skill to copy, or null while the dialog is closed. */
  stat: SkillUsageStat | null;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog
      open={!!stat}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Keyed on the skill, so a new pick starts with nothing ticked and no stale search. */}
      {stat && <AddUsedSkillContent key={stat.skill} stat={stat} onDone={onClose} />}
    </Dialog>
  );
}
