import type { Project } from '@runova/core';
import type { HealthTargetDetail, HealthTargetSummary } from '@shared/healthTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, Sparkles, Spinner, TerminalSquare } from '@/components/icons';
import { FOOTER_HAIRLINE, Problem } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { HealthStatusChip } from './HealthStatusChip';
import { HEALTH_STATE_META, healthBucket, targetHost } from './healthView';
import { PaneShimmer, TextPane, useSendToAgent } from './promptParts';
import { useHealthActions } from './useHealth';

/**
 * "Build the endpoint with AI" for a target that exists: the prompt that has an agent build a
 * compatible, secured endpoint in the project, and the protocol it follows. The prompt can go straight to the project's agent, and
 * once the endpoint is up, Test connection runs a check and says what came back.
 */

function TestResult({ result }: { result: HealthTargetDetail }): React.JSX.Element {
  const state = result.target.state;
  const good = healthBucket(state) === 'healthy';
  const reason = result.report?.problem ?? result.report?.output ?? HEALTH_STATE_META[state].hint;
  return (
    <div
      role="status"
      aria-label="Connection test"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs ring-1 ring-inset',
        good ? 'bg-success/8 ring-success/25' : 'bg-foreground/[0.04] ring-foreground/[0.08]',
      )}
    >
      <HealthStatusChip state={state} />
      <span className="min-w-0 flex-1 text-muted-foreground">
        {good ? 'The endpoint answered and every check passed.' : reason}
      </span>
    </div>
  );
}

export function HealthSetupDialog({
  open,
  onOpenChange,
  target,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: HealthTargetSummary;
  project: Project | undefined;
}): React.JSX.Element {
  const actions = useHealthActions();
  const [tab, setTab] = useState<'prompt' | 'spec'>('prompt');
  const [tested, setTested] = useState<HealthTargetDetail | null>(null);

  useEffect(() => {
    if (open) setTested(null);
  }, [open]);

  const setup = useQuery({
    queryKey: [...queryKeys.healthTarget(target.id), 'setup'],
    queryFn: () => window.runova.health.setupPrompt(target.id),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: { silentLoading: true },
  });

  const agent = useSendToAgent(project);

  function sendToAgent(): void {
    if (setup.data && agent.send(setup.data.prompt)) onOpenChange(false);
  }

  async function testConnection(): Promise<void> {
    setTested(null);
    try {
      setTested(await actions.checkNow.mutateAsync(target.id));
    } catch {
      // The mutation's own toast already said what went wrong.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[min(52rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        <DialogHeader className="px-5 py-4 pr-12 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Build the endpoint with AI
          </DialogTitle>
          <DialogDescription className="text-xs">
            Give this prompt to your AI agent. It adds a secured health endpoint to{' '}
            {project?.name ?? 'the project'} at{' '}
            <span className="font-mono">{targetHost(target.url)}</span> that answers in the format
            Runova reads. Then set the key's hash on the server and test the connection.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {setup.isError ? (
            <Problem
              message={`Could not build the prompt: ${setup.error.message}`}
              onRetry={() => void setup.refetch()}
            />
          ) : (
            <Tabs value={tab} onValueChange={(value) => setTab(value as 'prompt' | 'spec')}>
              <TabsList>
                <TabsTrigger value="prompt">Prompt</TabsTrigger>
                <TabsTrigger value="spec">Protocol</TabsTrigger>
              </TabsList>
              <TabsContent value="prompt" className="mt-3">
                {setup.data ? (
                  <TextPane
                    text={setup.data.prompt}
                    copyLabel="Copy prompt"
                    copyWhat="Prompt"
                    label="Prompt for your agent"
                  />
                ) : (
                  <PaneShimmer />
                )}
              </TabsContent>
              <TabsContent value="spec" className="mt-3">
                {setup.data ? (
                  <TextPane text={setup.data.spec} copyLabel="Copy protocol" copyWhat="Protocol" />
                ) : (
                  <PaneShimmer />
                )}
              </TabsContent>
            </Tabs>
          )}
          {tested && <TestResult result={tested} />}
        </div>

        <DialogFooter
          className={cn(
            FOOTER_HAIRLINE,
            'flex-row items-center gap-2 px-5 py-3 sm:justify-between',
          )}
        >
          <Button
            variant="soft"
            size="sm"
            onClick={() => void testConnection()}
            disabled={actions.checkNow.isPending}
            aria-busy={actions.checkNow.isPending}
          >
            {actions.checkNow.isPending ? <Spinner className="animate-spin" /> : <Link />}
            Test connection
          </Button>
          <Button size="sm" disabled={!setup.data || !project} onClick={sendToAgent}>
            <TerminalSquare />
            Send to {agent.cliName ?? 'agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
