import type { ScheduledTask } from '@runova/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { runPromptInTerminal } from '@/lib/runScheduledPrompt';

/**
 * Opens automatic scheduled prompts when main says they're due. Main has already marked each one
 * completed before sending it, so this only has to start the CLI and refresh the lists.
 */
export function useScheduledTaskRunner(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasksAll });
    };

    const run = async (task: ScheduledTask): Promise<void> => {
      const projects = await window.runova.projects.list();
      const project = projects.find((p) => p.id === task.projectId);
      const cliName = await runPromptInTerminal({
        projectId: task.projectId,
        cwd: project?.folderPath,
        content: task.content,
        fileKey: `scheduled-task-${task.id}`,
        targetAI: task.targetAI,
        cliId: task.cliId,
        model: task.model,
        effort: task.effort,
      });
      if (cliName) {
        toast.success(`Scheduled prompt started in ${cliName}`, {
          description: project?.name,
        });
      } else {
        toast.error('A scheduled prompt was due, but no CLI is set up to run it.', {
          description: project?.name,
        });
      }
      refresh();
    };

    const stopDue = window.runova.scheduledTasks.onDue((task) => void run(task));
    const stopChanged = window.runova.scheduledTasks.onChanged(refresh);
    return () => {
      stopDue();
      stopChanged();
    };
  }, [queryClient]);
}
