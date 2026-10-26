import { getCliDefinition, type Project } from '@runova/core';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Copy } from '@/components/icons';
import { SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { launchPromptTab, projectCliId } from '@/lib/workspace/launch';

/**
 * The prompt pane and the hand-off to the project's agent, shared by the dialogs that give an
 * agent the Runova Health Protocol to build an endpoint from.
 */

export function copyText(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error(`Could not copy the ${what.toLowerCase()}`),
  );
}

export function TextPane({
  text,
  copyLabel,
  copyWhat,
  label,
}: {
  text: string;
  copyLabel: string;
  copyWhat: string;
  /** Names the pane for screen readers. */
  label?: string;
}): React.JSX.Element {
  return (
    <div
      role={label ? 'region' : undefined}
      aria-label={label}
      className={cn(SECTION_WELL, 'relative p-0')}
    >
      <div className="absolute right-2 top-2">
        <Button size="xs" variant="soft" onClick={() => copyText(text, copyWhat)}>
          <Copy />
          {copyLabel}
        </Button>
      </div>
      <pre className="max-h-[46vh] overflow-auto whitespace-pre-wrap break-words p-3 pr-28 font-mono text-[12px] leading-relaxed text-foreground/90">
        {text}
      </pre>
    </div>
  );
}

export function PaneShimmer(): React.JSX.Element {
  return (
    <div className={cn(SECTION_WELL, 'space-y-2')} role="status" aria-label="Building the prompt">
      {[92, 84, 76, 88, 60].map((width) => (
        <Skeleton key={width} className="h-3" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

/**
 * The project's agent by name ("Claude Code"), and a way to start it in the project's workspace
 * with a prompt. `send` returns whether a tab was started, so the caller can close itself.
 */
export function useSendToAgent(project: Project | undefined): {
  cliName: string | null;
  send: (prompt: string) => boolean;
} {
  const navigate = useNavigate();
  const cliId = project ? projectCliId(project) : null;
  const cli = cliId ? getCliDefinition(cliId) : undefined;
  const cliName = cli?.label ?? cli?.name ?? null;

  function send(prompt: string): boolean {
    if (!project || !prompt) return false;
    if (!cliId) {
      toast.error('Pick an agent for this project first', {
        description: 'Set the default CLI in Settings, or the project CLI on its Overview.',
      });
      return false;
    }
    const tabId = launchPromptTab(project, { cliId, prompt });
    if (!tabId) return false;
    navigate(`/workspace/${project.id}`);
    toast.success(`Starting ${cliName ?? 'the agent'}`, {
      description: 'The prompt goes in once it is ready. Press Enter in the tab to run it.',
    });
    return true;
  }

  return { cliName, send };
}
