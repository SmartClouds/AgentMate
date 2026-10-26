import {
  type Project,
  type ProjectDraft,
  type ScheduledTask,
  targetAIForProject,
} from '@runova/core';
import type { PromptHistoryEntry, ScheduledTaskInput } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CalendarDays, FileText, History, Plus, Search, Sparkles } from '@/components/icons';
import { PillTabs, SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { runPromptInTerminal } from '@/lib/runScheduledPrompt';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { SectionEmptyState } from '../ProjectDetailChrome';
import { MoveEntryDialog } from './MoveEntryDialog';
import {
  type ComposerInitial,
  type ComposerValues,
  PromptComposerDialog,
} from './PromptComposerDialog';
import { DraftRow, HistoryRow, ScheduledRow } from './PromptRows';
import {
  draftPromptText,
  groupByDay,
  groupScheduled,
  isPromptView,
  matchesSearch,
  mergePromptItems,
  type PromptItem,
  type PromptView,
  taskPromptText,
} from './promptItems';

type ComposerState =
  | { mode: 'new'; initial: ComposerInitial }
  | { mode: 'edit'; task: ScheduledTask }
  | { mode: 'promote'; draft: ProjectDraft };

/**
 * Every prompt of a project in one place: what was sent (history), what is still being written
 * (drafts), and what is ready to run by hand or on a timer (scheduled).
 */
export function ProjectPrompts({ project }: { project: Project }): React.JSX.Element {
  const projectId = project.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get('view');
  const view: PromptView = isPromptView(viewParam) ? viewParam : 'all';
  const [search, setSearch] = useState('');
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [movingEntry, setMovingEntry] = useState<PromptHistoryEntry | null>(null);
  const [savingDraftId, setSavingDraftId] = useState<string | null>(null);
  const [showImplemented, setShowImplemented] = useState(false);

  function setView(next: PromptView): void {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'all') params.delete('view');
        else params.set('view', next);
        return params;
      },
      { replace: true },
    );
  }

  const historyQuery = useQuery({
    queryKey: queryKeys.projectPromptHistory(projectId),
    queryFn: () => window.runova.promptHistory.list(projectId),
  });
  const draftsQuery = useQuery({
    queryKey: queryKeys.projectDrafts(projectId),
    queryFn: () => window.runova.projectDrafts.listByProject(projectId),
  });
  const tasksQuery = useQuery({
    queryKey: queryKeys.scheduledTasks(projectId),
    queryFn: () => window.runova.scheduledTasks.listByProject(projectId),
    // Keeps the "in 12m" countdowns honest while the tab sits open.
    refetchInterval: 60_000,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });
  const otherProjects = (projectsQuery.data ?? []).filter((p) => p.id !== projectId);

  const history = historyQuery.data ?? [];
  const drafts = draftsQuery.data ?? [];
  const tasks = tasksQuery.data ?? [];

  const refreshHistory = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.promptHistory });
  };
  const refreshDrafts = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectDrafts(projectId) });
  };
  const refreshTasks = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks(projectId) });
  };

  // History
  const deleteHistoryMutation = useMutation({
    mutationFn: (id: string) => window.runova.promptHistory.remove(id),
    onSuccess: refreshHistory,
    onError: () => toast.error('Could not delete this entry.'),
  });
  const moveHistoryMutation = useMutation({
    mutationFn: ({ id, targetProjectId }: { id: string; targetProjectId: string }) =>
      window.runova.promptHistory.setProject(id, targetProjectId),
    onSuccess: (_result, { targetProjectId }) => {
      refreshHistory();
      setMovingEntry(null);
      const target = projectsQuery.data?.find((p) => p.id === targetProjectId);
      toast.success(target ? `Moved to ${target.name}.` : 'Moved to the other project.');
    },
    onError: () => toast.error('Could not move this entry.'),
  });

  // Drafts
  const updateDraftMutation = useMutation({
    mutationFn: ({ draft, text }: { draft: ProjectDraft; text: string }) =>
      window.runova.projectDrafts.update(
        draft.id,
        // A draft with a generated prompt keeps its original request; one without is just its text.
        draft.content.trim() ? { content: text } : { rawInput: text },
      ),
    onMutate: ({ draft }) => setSavingDraftId(draft.id),
    onSettled: () => setSavingDraftId(null),
    onSuccess: refreshDrafts,
    onError: () => toast.error('Could not save the draft.'),
  });
  const draftStatusMutation = useMutation({
    mutationFn: (draft: ProjectDraft) =>
      window.runova.projectDrafts.updateStatus(
        draft.id,
        draft.status === 'implemented' ? 'draft' : 'implemented',
      ),
    onSuccess: (_result, draft) => {
      toast.success(draft.status === 'implemented' ? 'Draft reopened.' : 'Marked as implemented.');
      refreshDrafts();
    },
    onError: () => toast.error('Could not update the draft.'),
  });
  const removeDraftMutation = useMutation({
    mutationFn: (id: string) => window.runova.projectDrafts.remove(id),
    onSuccess: refreshDrafts,
  });

  // Scheduled
  const taskStatusMutation = useMutation({
    mutationFn: (params: { id: string; status: ScheduledTask['status'] }) =>
      window.runova.scheduledTasks.updateStatus(params.id, params.status),
    onSuccess: refreshTasks,
  });
  const removeTaskMutation = useMutation({
    mutationFn: (id: string) => window.runova.scheduledTasks.remove(id),
    onSuccess: refreshTasks,
  });

  const targetAI = targetAIForProject(project.agentType, project.cliId);

  function scheduleInput(
    values: ComposerValues,
    base?: { rawInput: string; promptType: string; targetAI: string },
  ): ScheduledTaskInput {
    return {
      rawInput: base?.rawInput || values.text,
      promptType: base?.promptType ?? '',
      targetAI: base?.targetAI || targetAI,
      content: values.text,
      runAt: values.runAt,
      runMode: values.runMode,
      cliId: values.run.cliId,
      model: values.run.model,
      effort: values.run.effort,
    };
  }

  const composerMutation = useMutation({
    mutationFn: async ({ state, values }: { state: ComposerState; values: ComposerValues }) => {
      if (state.mode === 'edit') {
        await window.runova.scheduledTasks.update(state.task.id, {
          content: values.text,
          runAt: values.runMode === 'auto' ? values.runAt : state.task.runAt,
          runMode: values.runMode,
          // null clears a previous choice, so the task falls back to the defaults.
          cliId: values.run.cliId ?? null,
          model: values.run.model ?? null,
          effort: values.run.effort ?? null,
          // A missed task given a fresh time goes back in the queue.
          ...(state.task.status === 'missed' ? { status: 'pending' as const } : {}),
        });
        return 'Scheduled prompt updated.';
      }
      if (state.mode === 'promote') {
        await window.runova.projectDrafts.promoteToScheduled(
          state.draft.id,
          scheduleInput(values, state.draft),
        );
        return 'Moved to Scheduled.';
      }
      if (values.kind === 'draft') {
        await window.runova.projectDrafts.create({
          projectId,
          rawInput: values.text,
          promptType: '',
          targetAI,
          content: '',
        });
        return 'Draft saved.';
      }
      await window.runova.scheduledTasks.createMany({
        projectId,
        tasks: [scheduleInput(values)],
      });
      return 'Prompt scheduled.';
    },
    onSuccess: (message, { state, values }) => {
      toast.success(message);
      refreshDrafts();
      refreshTasks();
      setComposer(null);
      if (state.mode === 'promote' || (state.mode === 'new' && values.kind === 'scheduled')) {
        setView('scheduled');
      } else if (state.mode === 'new') {
        setView('drafts');
      }
    },
    onError: () => toast.error('Could not save the prompt.'),
  });

  async function copy(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard.');
  }

  async function runTask(task: ScheduledTask): Promise<void> {
    const cliName = await runPromptInTerminal({
      projectId,
      cwd: project.folderPath,
      content: taskPromptText(task),
      fileKey: `scheduled-task-${task.id}`,
      targetAI: task.targetAI,
      cliId: task.cliId,
      model: task.model,
      effort: task.effort,
    });
    if (!cliName) {
      toast.error('No CLI available for this prompt. Pick one, or set a default CLI in Settings.');
      return;
    }
    await window.runova.scheduledTasks.markRan(task.id);
    refreshTasks();
  }

  function confirmDelete(what: string, onConfirm: () => void): void {
    void confirmDialog({
      title: `Delete this ${what}?`,
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    }).then((confirmed) => {
      if (confirmed) onConfirm();
    });
  }

  function openNew(): void {
    setComposer({
      mode: 'new',
      initial: {
        kind: view === 'scheduled' ? 'scheduled' : 'draft',
        run: project.cliId ? { cliId: project.cliId } : {},
      },
    });
  }

  function renderItem(item: PromptItem): React.JSX.Element {
    switch (item.kind) {
      case 'history':
        return (
          <HistoryRow
            key={item.id}
            entry={item.entry}
            canMove={otherProjects.length > 0}
            onCopy={(text) => void copy(text)}
            onMove={() => setMovingEntry(item.entry)}
            onDelete={() =>
              confirmDelete('history entry', () => deleteHistoryMutation.mutate(item.entry.id))
            }
          />
        );
      case 'draft':
        return (
          <DraftRow
            key={item.id}
            draft={item.draft}
            saving={savingDraftId === item.draft.id}
            onSave={(text) => updateDraftMutation.mutate({ draft: item.draft, text })}
            onSchedule={() => setComposer({ mode: 'promote', draft: item.draft })}
            onToggleImplemented={() => draftStatusMutation.mutate(item.draft)}
            onCopy={(text) => void copy(text)}
            onDelete={() => confirmDelete('draft', () => removeDraftMutation.mutate(item.draft.id))}
          />
        );
      case 'scheduled':
        return (
          <ScheduledRow
            key={item.id}
            task={item.task}
            onRun={() => void runTask(item.task)}
            onEdit={() => setComposer({ mode: 'edit', task: item.task })}
            onCancel={() => taskStatusMutation.mutate({ id: item.task.id, status: 'cancelled' })}
            onCopy={(text) => void copy(text)}
            onDelete={() =>
              confirmDelete('scheduled prompt', () => removeTaskMutation.mutate(item.task.id))
            }
          />
        );
    }
  }

  const allItems = mergePromptItems(history, drafts, tasks).filter((item) =>
    matchesSearch(item, search),
  );
  const draftItems = mergePromptItems([], drafts, []).filter((item) => matchesSearch(item, search));
  const openDrafts = draftItems.filter(
    (item) => item.kind === 'draft' && item.draft.status === 'draft',
  );
  const doneDrafts = draftItems.filter(
    (item) => item.kind === 'draft' && item.draft.status === 'implemented',
  );
  const taskItems = mergePromptItems([], [], tasks).filter((item) => matchesSearch(item, search));
  const scheduledGroups = groupScheduled(
    taskItems.flatMap((item) => (item.kind === 'scheduled' ? [item.task] : [])),
  );
  const asItems = (list: ScheduledTask[]): PromptItem[] =>
    list.map((task) => ({
      kind: 'scheduled',
      id: `scheduled:${task.id}`,
      date: task.createdAt,
      task,
    }));

  const openDraftCount = drafts.filter((d) => d.status === 'draft').length;
  const waitingCount = tasks.filter((t) => t.status === 'pending' || t.status === 'missed').length;
  const missedCount = tasks.filter((t) => t.status === 'missed').length;
  const searching = search.trim().length > 0;

  const composerProps = composerDialogProps(composer);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl px-1 text-sm text-muted-foreground">
          Everything you've sent, are still writing, or have lined up to run on this project.
        </p>
        <div className="flex items-center gap-1.5">
          <Button variant="soft" onClick={() => navigate('/prompt-builder')}>
            <Sparkles /> Prompt Builder
          </Button>
          <Button onClick={openNew}>
            <Plus /> New prompt
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <PillTabs
          id="prompt-views"
          label="Prompt views"
          items={[
            {
              value: 'all',
              label: 'History',
              icon: <History />,
              count: history.length + drafts.length + tasks.length,
            },
            { value: 'drafts', label: 'Drafts', icon: <FileText />, count: openDraftCount },
            {
              value: 'scheduled',
              label: 'Scheduled',
              icon: <CalendarDays />,
              count: waitingCount,
              // The count turns red while a prompt has missed its time.
              countTone: missedCount > 0 ? 'destructive' : undefined,
            },
          ]}
          value={view}
          onChange={setView}
        />
        <SearchPill
          label="Search prompts"
          placeholder="Search prompts…"
          value={search}
          onValueChange={setSearch}
          className="w-full max-w-xs"
        />
      </div>

      {view === 'all' ? (
        <div className="space-y-5">
          {historyQuery.isPending || draftsQuery.isPending || tasksQuery.isPending ? (
            <ListSkeleton />
          ) : allItems.length === 0 ? (
            searching ? (
              <NoMatches query={search} />
            ) : (
              <SectionEmptyState
                icon={History}
                title="No prompts yet"
                description="Prompts you generate or translate for this project, plus its drafts and scheduled prompts, show up here."
                action={
                  <Button variant="outline" size="sm" onClick={openNew}>
                    <Plus /> New prompt
                  </Button>
                }
              />
            )
          ) : (
            groupByDay(allItems).map((group) => (
              <Group key={group.label} label={group.label}>
                {group.items.map(renderItem)}
              </Group>
            ))
          )}
        </div>
      ) : null}

      {view === 'drafts' ? (
        <div className="space-y-5">
          {draftsQuery.isPending ? (
            <ListSkeleton />
          ) : openDrafts.length === 0 && doneDrafts.length === 0 ? (
            searching ? (
              <NoMatches query={search} />
            ) : (
              <SectionEmptyState
                icon={FileText}
                title="No drafts"
                description="Park a prompt you haven't finished yet. When it's ready, schedule it to run."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setComposer({ mode: 'new', initial: { kind: 'draft' } })}
                  >
                    <Plus /> New draft
                  </Button>
                }
              />
            )
          ) : (
            <>
              {openDrafts.length > 0 ? (
                <Group label="In progress">{openDrafts.map(renderItem)}</Group>
              ) : null}
              {doneDrafts.length > 0 ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => setShowImplemented((v) => !v)}
                  >
                    {showImplemented ? 'Hide' : 'Show'} {doneDrafts.length} implemented
                  </button>
                  {showImplemented ? (
                    <div className="space-y-2">{doneDrafts.map(renderItem)}</div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {view === 'scheduled' ? (
        <div className="space-y-5">
          {tasksQuery.isPending ? (
            <ListSkeleton />
          ) : taskItems.length === 0 ? (
            searching ? (
              <NoMatches query={search} />
            ) : (
              <SectionEmptyState
                icon={CalendarDays}
                title="Nothing scheduled"
                description="Schedule a finished prompt to run when you press Run, or automatically at a set time, in the CLI, model and effort you pick."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setComposer({
                        mode: 'new',
                        initial: {
                          kind: 'scheduled',
                          run: project.cliId ? { cliId: project.cliId } : {},
                        },
                      })
                    }
                  >
                    <Plus /> Schedule a prompt
                  </Button>
                }
              />
            )
          ) : (
            <>
              {scheduledGroups.attention.length > 0 ? (
                <Group label="Needs attention" tone="attention">
                  {asItems(scheduledGroups.attention).map(renderItem)}
                </Group>
              ) : null}
              {scheduledGroups.upcoming.length > 0 ? (
                <Group label="Up next">{asItems(scheduledGroups.upcoming).map(renderItem)}</Group>
              ) : null}
              {scheduledGroups.past.length > 0 ? (
                <Group label="Done">{asItems(scheduledGroups.past).map(renderItem)}</Group>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {composer && composerProps ? (
        <PromptComposerDialog
          key={composerKey(composer)}
          open
          {...composerProps}
          pending={composerMutation.isPending}
          onClose={() => setComposer(null)}
          onSubmit={(values) => composerMutation.mutate({ state: composer, values })}
        />
      ) : null}

      <MoveEntryDialog
        key={movingEntry?.id ?? 'none'}
        entry={movingEntry}
        projects={otherProjects}
        pending={moveHistoryMutation.isPending}
        onClose={() => setMovingEntry(null)}
        onMove={(targetProjectId) => {
          if (movingEntry) moveHistoryMutation.mutate({ id: movingEntry.id, targetProjectId });
        }}
      />
    </div>
  );
}

function composerKey(state: ComposerState): string {
  if (state.mode === 'edit') return `edit:${state.task.id}`;
  if (state.mode === 'promote') return `promote:${state.draft.id}`;
  return 'new';
}

function composerDialogProps(state: ComposerState | null): {
  title: string;
  description?: string;
  initial: ComposerInitial;
  lockKind?: boolean;
  submitLabel?: string;
} | null {
  if (!state) return null;
  if (state.mode === 'edit') {
    const { task } = state;
    return {
      title: 'Edit scheduled prompt',
      initial: {
        kind: 'scheduled',
        text: taskPromptText(task),
        runMode: task.runMode ?? 'manual',
        runAt: task.runAt,
        run: { cliId: task.cliId, model: task.model, effort: task.effort },
      },
      lockKind: true,
      submitLabel: 'Save changes',
    };
  }
  if (state.mode === 'promote') {
    return {
      title: 'Schedule this draft',
      description: 'It moves from Drafts to Scheduled.',
      initial: { kind: 'scheduled', text: draftPromptText(state.draft) },
      lockKind: true,
    };
  }
  return { title: 'New prompt', initial: state.initial };
}

function Group({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: 'attention';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h3
        className={cn(
          'text-[11px] font-semibold uppercase tracking-wider',
          tone === 'attention' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {label}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading prompts" className="space-y-2">
      <Skeleton className="h-16 w-full rounded-[calc(var(--radius)+2px)]" />
      <Skeleton className="h-16 w-full rounded-[calc(var(--radius)+2px)]" />
      <Skeleton className="h-16 w-full rounded-[calc(var(--radius)+2px)]" />
    </div>
  );
}

function NoMatches({ query }: { query: string }): React.JSX.Element {
  return (
    <div className="glass flex flex-col items-center gap-2 rounded-[calc(var(--radius)+2px)] py-10 text-center">
      <Search className="h-4 w-4 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">No prompts match "{query.trim()}".</p>
    </div>
  );
}
