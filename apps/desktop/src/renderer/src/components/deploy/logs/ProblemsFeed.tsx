import type { ContainerSummary } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useState } from 'react';
import { CircleCheck, CircleX, FolderKanban, Robot, TriangleAlert } from '@/components/icons';
import { Chip, EmptyState, GLASS_CARD } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PROBLEM_LABELS, type Problem } from '@/lib/deploy/problems/problems';
import { cn } from '@/lib/utils';
import { useDeployAssistantStore } from '@/stores/deployAssistantStore';
import { SendLogsDialog } from '../containers/SendLogsDialog';
import { GLASS_EDGE } from '../deployKit';
import { useProblems } from './useProblems';

/**
 * The problems feed (E09 T2, signature interaction 4): every card says what is wrong in words
 * (and with an icon, never colour alone), and offers "Diagnose with AI", which opens the Deploy AI
 * on it, and for a container "Fix in project", which hands its redacted log to the project's CLI.
 */

const PROMPTS: Record<Problem['kind'], string> = {
  crashLoop:
    'Find out why this container keeps restarting, and fix it if the cause is on the server.',
  unhealthy: 'Find out why this container fails its health check.',
  failedDeploy: 'Find out why this deploy failed.',
  diskPressure: 'Find out what is filling the disk and what can safely be cleaned up.',
  certificate: 'Find out why this certificate is not renewing.',
  exposedPort: 'Check what this published port exposes and how to keep it private.',
  alert: 'Look into this alert and tell me what it means.',
};

function ProblemCard({
  problem,
  onDiagnose,
  onFix,
}: {
  problem: Problem;
  onDiagnose: () => void;
  onFix?: () => void;
}): React.JSX.Element {
  const critical = problem.severity === 'critical';
  return (
    <li
      aria-label={problem.title}
      className={cn(
        GLASS_CARD,
        'flex flex-col gap-2 p-4',
        critical ? GLASS_EDGE.destructive : GLASS_EDGE.warning,
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Chip tone={critical ? 'destructive' : 'warning'}>
          {critical ? <CircleX /> : <TriangleAlert />}
          {critical ? 'Critical' : 'Warning'}
        </Chip>
        <span className="text-muted-foreground">{PROBLEM_LABELS[problem.kind]}</span>
      </div>
      <h3 className="text-sm font-semibold text-foreground">{problem.title}</h3>
      <p className="text-xs text-muted-foreground">{problem.detail}</p>
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        <Button size="sm" onClick={onDiagnose}>
          <Robot /> Diagnose with AI
        </Button>
        {onFix && (
          <Button size="sm" variant="soft" onClick={onFix}>
            <FolderKanban /> Fix in project
          </Button>
        )}
      </div>
    </li>
  );
}

export function ProblemsFeed({ server }: { server: DeployServer }): React.JSX.Element {
  const { problems, loading, containers } = useProblems(server.id);
  const open = useDeployAssistantStore((state) => state.open);
  const [sending, setSending] = useState<ContainerSummary | null>(null);
  const all = containers?.groups.flatMap((group) => group.containers) ?? [];

  if (loading && problems.length === 0) {
    return (
      <ul aria-label="Problems" aria-busy="true" className="grid gap-2 xl:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <li key={i} className={cn(GLASS_CARD, 'space-y-2 p-4')}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
          </li>
        ))}
      </ul>
    );
  }

  if (problems.length === 0) {
    return (
      <div role="status">
        <EmptyState card icon={CircleCheck} title="Nothing needs attention right now." />
      </div>
    );
  }

  return (
    <>
      <ul aria-label="Problems" className="grid gap-2 xl:grid-cols-2">
        {problems.map((problem) => {
          const container = problem.containerId
            ? all.find((item) => item.id === problem.containerId)
            : undefined;
          return (
            <ProblemCard
              key={problem.id}
              problem={problem}
              onDiagnose={() =>
                open(server.id, {
                  prompt: PROMPTS[problem.kind],
                  context: {
                    title: `${PROBLEM_LABELS[problem.kind]}: ${problem.title}`,
                    facts: [problem.detail],
                    ...(problem.containerId ? { containerId: problem.containerId } : {}),
                  },
                })
              }
              onFix={container ? () => setSending(container) : undefined}
            />
          );
        })}
      </ul>
      <SendLogsDialog
        serverId={server.id}
        serverName={server.nickname}
        container={sending}
        onClose={() => setSending(null)}
      />
    </>
  );
}
