import { findGroup, getCliDefinition, type Project } from '@runova/core';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Spinner, Wand2 } from '@/components/icons';
import { FilterChip, Notice, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAgentChoices } from '@/components/workspace/useAgentChoices';
import {
  buildRunSetupPrompt,
  DEFAULT_RUN_SETUP_REQUEST,
  runSetupExamples,
} from '@/lib/runSetupPrompt';
import { launchPromptTab } from '@/lib/workspace/launch';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/** Only Claude Code takes an MCP config on its command line, so it is the one that can do this. */
const SETUP_CLI_ID = 'claude-code';

const STEPS = [
  {
    title: 'The agent looks at your project',
    detail: 'It reads your files. If a script is the cleanest way to run it, it can write one too.',
  },
  {
    title: 'It suggests a command',
    detail: 'The suggestion comes back to Runova. Nothing is saved at this point.',
  },
  {
    title: 'You review and add it',
    detail: 'Add command saves it to this project. Add and run saves it and starts it.',
  },
];

export interface CreateRunWithAiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project, or a worktree workspace of it (which carries the id of the project it came from). */
  project: Project & { parentId?: string };
  /** Where "I'll write it myself" goes, usually the project's run command editor. */
  onWriteMyself?: () => void;
}

/**
 * The plain way to get a run command made for you: say what you want in a sentence, and an agent
 * reads the project and suggests the command (or a script and the command that calls it). The
 * person never has to know about MCP or tool permissions. Start opens the agent in a workspace tab
 * with the request typed in, and the suggestion lands in the approval dialog.
 */
export function CreateRunWithAiDialog({
  open,
  onOpenChange,
  project,
  onWriteMyself,
}: CreateRunWithAiDialogProps): React.JSX.Element {
  const navigate = useNavigate();
  const requestId = useId();
  const requestRef = useRef<HTMLTextAreaElement>(null);
  const [request, setRequest] = useState(DEFAULT_RUN_SETUP_REQUEST);
  const [busy, setBusy] = useState(false);
  const agents = useAgentChoices(project);
  const platform = window.runova.platform;
  const cliLabel = getCliDefinition(SETUP_CLI_ID)?.label ?? 'Claude Code';
  // Start is held back only once we know the agent is missing, so it never waits on the lookup.
  const cliMissing = !agents.loading && !agents.installed.some((a) => a.cli.id === SETUP_CLI_ID);

  // Every visit starts from the default request, not from whatever was typed last time.
  useEffect(() => {
    if (open) setRequest(DEFAULT_RUN_SETUP_REQUEST);
  }, [open]);

  async function start(): Promise<void> {
    if (busy || cliMissing) return;
    setBusy(true);
    try {
      // In a worktree workspace the agent works in the worktree folder, but run commands belong
      // to the project it was made from.
      const session = await window.runova.runProposals.startGuided(project.parentId ?? project.id);
      if (!session.ok) {
        toast.error(session.error);
        return;
      }
      const workspace = useWorkspaceStore.getState().workspaces[project.id];
      const group = workspace ? findGroup(workspace.root, workspace.focusedGroupId) : null;
      const tabId = launchPromptTab(
        project,
        {
          cliId: SETUP_CLI_ID,
          prompt: buildRunSetupPrompt({
            request,
            projectName: project.name,
            folderPath: project.folderPath,
            platform,
          }),
          runArgs: [
            '--mcp-config',
            session.mcpConfigPath,
            '--allowedTools',
            ...session.allowedTools,
          ],
          runLabel: 'Run command setup',
        },
        group?.id,
      );
      if (!tabId) return;
      onOpenChange(false);
      navigate(`/workspace/${project.id}`);
      toast.success(`Starting ${cliLabel}`, {
        description:
          'Your request goes in as soon as it is ready. Press Enter in the tab to send it.',
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start the run setup.');
    } finally {
      setBusy(false);
    }
  }

  const submitKey = platform === 'darwin' ? 'Cmd+Enter' : 'Ctrl+Enter';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          // The request is the one thing to do here, so it takes focus with its text selected:
          // typing replaces the suggestion, and Start is one key away if it already says enough.
          event.preventDefault();
          requestRef.current?.focus();
          requestRef.current?.select();
        }}
      >
        <DialogHeader className="border-b border-border/70 px-6 py-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Wand2 className="h-4 w-4 text-primary" />
            Create a run command with AI
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Say what you want to run in {project.name}. An AI agent works out the command for you.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto px-6 py-5">
          <ol className="space-y-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/12 text-[11px] font-semibold text-primary"
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-5">{step.title}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="space-y-2">
            <Label htmlFor={requestId} className="text-sm font-medium">
              What should it run?
            </Label>
            <Textarea
              id={requestId}
              ref={requestRef}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void start();
                }
              }}
              rows={3}
              maxLength={2000}
              className="min-h-[5.5rem] resize-none leading-relaxed"
            />
            <p className="text-xs text-muted-foreground">
              Opens {cliLabel} in a new tab. {submitKey} starts it.
            </p>
          </div>

          <div className="space-y-2">
            <p className={SECTION_HEADING}>Or start from an example</p>
            <div className="flex flex-wrap gap-1.5">
              {runSetupExamples(platform).map((example) => (
                <FilterChip
                  key={example}
                  active={request === example}
                  onClick={() => {
                    setRequest(example);
                    requestRef.current?.focus();
                  }}
                  className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
                >
                  {example}
                </FilterChip>
              ))}
            </div>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Nothing is saved until you approve it, and nothing runs until you press Run or Add and
            run.
          </p>

          {cliMissing ? (
            <Notice
              tone="warning"
              size="sm"
              action={
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    onOpenChange(false);
                    navigate('/cli-manager');
                  }}
                >
                  Open AI CLI Manager
                </Button>
              }
            >
              {cliLabel} is not installed on this computer. Install it from AI CLI Manager, then
              come back.
            </Notice>
          ) : null}
        </div>

        <DialogFooter className="items-center gap-2 border-t border-border/70 bg-muted/20 px-6 py-3.5 sm:justify-between">
          {onWriteMyself ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onWriteMyself();
              }}
            >
              I&apos;ll write it myself
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={busy || cliMissing}
            onClick={() => void start()}
          >
            {busy ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : null}
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
