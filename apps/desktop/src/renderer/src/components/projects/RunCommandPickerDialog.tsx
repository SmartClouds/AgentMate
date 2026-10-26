import type { Project, ProjectRunCommand } from '@runova/core';
import {
  configuredRunCommands,
  parseRunInputs,
  projectRunCommandTitle,
  runCommandSummary,
} from '@runova/core';
import { useEffect, useRef } from 'react';
import { Play } from '@/components/icons';
import { RunInputForm } from '@/components/projects/RunInputForm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface RunCommandPickerDialogProps {
  open: boolean;
  project: Project | null;
  /** The command whose values are being asked for. Null shows the list of commands instead. */
  command: ProjectRunCommand | null;
  /** The form was opened from the list, so it offers Back. */
  fromList: boolean;
  /** The entry picked last, focused again when Back returns to the list. */
  pickedId?: string;
  /** Changes with every open, so a form starts from its defaults each time. */
  targetId: number;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  onPick: (command: ProjectRunCommand) => void;
  onBack: () => void;
  /** Called with the finished command, ready to type into the terminal. */
  onRun: (text: string) => void;
}

/**
 * Two steps in one dialog: the project's commands, then the values a chosen command needs.
 * Swapping the body keeps a single dialog open, rather than closing one and opening another.
 */
export function RunCommandPickerDialog({
  open,
  project,
  command,
  fromList,
  pickedId,
  targetId,
  onOpenChange,
  onCloseAutoFocus,
  onPick,
  onBack,
  onRun,
}: RunCommandPickerDialogProps): React.JSX.Element {
  const title = command ? `Run ${projectRunCommandTitle(command)}` : 'Run command';
  let description = 'Choose a command to run.';
  if (project) {
    description = command
      ? `Fill in the values, then run it in ${project.name}.`
      : `Which command should ${project.name} start with?`;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-4" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {command ? (
          <RunInputForm
            key={targetId}
            command={command.command}
            onRun={onRun}
            onBack={fromList ? onBack : undefined}
            onCancel={() => onOpenChange(false)}
          />
        ) : (
          <CommandList
            commands={project ? configuredRunCommands(project) : []}
            pickedId={pickedId}
            onPick={onPick}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CommandList({
  commands,
  pickedId,
  onPick,
}: {
  commands: ProjectRunCommand[];
  pickedId?: string;
  onPick: (command: ProjectRunCommand) => void;
}): React.JSX.Element {
  const pickedRef = useRef<HTMLButtonElement>(null);
  // Back returns here, and the entry picked last gets focus again so the list picks up where it left off.
  useEffect(() => {
    pickedRef.current?.focus();
  }, []);

  // Padding and scroll-py-1 keep the focus ring from being clipped at the edges.
  // The negative margin cancels the padding so the layout does not move.
  return (
    <div className="-mx-1 -my-1 flex min-h-0 flex-col gap-2 overflow-y-auto px-1 py-1 scroll-py-1">
      {commands.map((entry) => {
        const showCommand = entry.label.trim().length > 0;
        const asksForInput = parseRunInputs(entry.command).length > 0;
        return (
          <button
            key={entry.id}
            ref={entry.id === pickedId ? pickedRef : undefined}
            type="button"
            onClick={() => onPick(entry)}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Play className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium">
                  {projectRunCommandTitle(entry)}
                </span>
                {asksForInput ? (
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    Asks for input
                  </span>
                ) : null}
              </span>
              {showCommand ? (
                <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                  {runCommandSummary(entry.command)}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
