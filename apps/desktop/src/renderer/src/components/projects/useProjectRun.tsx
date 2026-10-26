import type { Project, ProjectRunCommand } from '@runova/core';
import { classifyRunCommand, configuredRunCommands, parseRunInputs } from '@runova/core';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { RunCommandPickerDialog } from '@/components/projects/RunCommandPickerDialog';
import { useTerminalStore } from '@/stores/terminalStore';

/**
 * What the picker is showing. It stays set after the dialog closes, so the close animation still
 * has something to show.
 */
interface RunTarget {
  /** Changes with every open, so a form starts from its defaults each time. */
  id: number;
  project: Project;
  /** The command whose values are being asked for. Null while the list is showing. */
  command: ProjectRunCommand | null;
  /** The form was reached from the list, so Back returns there. */
  fromList: boolean;
  /** The entry picked from the list last, focused again when Back returns to it. */
  pickedId?: string;
}

export function useProjectRun(): {
  requestRun: (project: Project, options?: { onEmpty?: () => void }) => void;
  /** Runs one specific command, skipping the list. A command with placeholders asks for them first. */
  runCommand: (project: Project, command: ProjectRunCommand) => void;
  runPicker: React.JSX.Element;
} {
  const openSession = useTerminalStore((s) => s.openSession);
  const [target, setTarget] = useState<RunTarget | null>(null);
  const [open, setOpen] = useState(false);
  const lastId = useRef(0);
  // Radix only returns focus to its own triggers, and the Run buttons are not one. So the element
  // that opened the picker is remembered, and gets focus back when the picker closes.
  const opener = useRef<HTMLElement | null>(null);

  function rememberOpener(): void {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
  }

  function showPicker(next: Omit<RunTarget, 'id'>): void {
    lastId.current += 1;
    setTarget({ ...next, id: lastId.current });
    setOpen(true);
  }

  function start(project: Project, command: ProjectRunCommand, text: string): void {
    // A named run is listed by its environment, an unnamed one by the command it actually runs.
    const label = command.label.trim() || text;
    openSession({
      title: project.name,
      cwd: project.folderPath,
      projectId: project.id,
      // Enter included: the status bar follows a run, so it starts without another key press.
      initialInput: `${text}\r`,
      run: {
        commandId: command.id,
        label,
        command: text,
        kind: classifyRunCommand(text),
        startedAt: Date.now(),
      },
    });
    toast.info(`Running "${label}".`);
    setOpen(false);
  }

  /** Runs a command now, or opens its form first when it has placeholders to fill in. */
  function choose(project: Project, command: ProjectRunCommand, fromList: boolean): void {
    if (parseRunInputs(command.command).length === 0) {
      start(project, command, command.command);
      return;
    }
    // Coming from the list keeps the opener from the first open, since it is still the same dialog.
    if (!fromList) rememberOpener();
    showPicker({ project, command, fromList, pickedId: fromList ? command.id : undefined });
  }

  function requestRun(project: Project, options?: { onEmpty?: () => void }): void {
    const [first, ...rest] = configuredRunCommands(project);
    if (!first) {
      options?.onEmpty?.();
      return;
    }
    if (rest.length === 0) {
      choose(project, first, false);
      return;
    }
    rememberOpener();
    showPicker({ project, command: null, fromList: false });
  }

  return {
    requestRun,
    runCommand: (project, command) => choose(project, command, false),
    runPicker: (
      <RunCommandPickerDialog
        open={open}
        project={target?.project ?? null}
        command={target?.command ?? null}
        fromList={target?.fromList ?? false}
        pickedId={target?.pickedId}
        targetId={target?.id ?? 0}
        onOpenChange={setOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
        onPick={(command) => {
          if (target) choose(target.project, command, true);
        }}
        onBack={() =>
          setTarget((prev) => (prev ? { ...prev, command: null, fromList: false } : prev))
        }
        onRun={(text) => {
          if (target?.command) start(target.project, target.command, text);
        }}
      />
    ),
  };
}
