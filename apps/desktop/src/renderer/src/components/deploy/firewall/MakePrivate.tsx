import { coreErrorMessage } from '@shared/coreErrors';
import type { ContainerPortInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CircleCheck, Copy, Lock, Spinner, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  classifyContainer,
  findContainer,
  type MakePrivateTarget,
  privateChange,
  publicAddress,
} from '@/lib/deploy/firewall/makePrivate';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { useStack } from '../apps/hooks';
import { CODE_WELL } from '../security/SecurityCard';

/**
 * "Make private" in the exposure view (E13 T5). For a container of a Runova app it asks
 * first, then redeploys the app as a new revision with the service on 127.0.0.1 (the core
 * audits it as a revision made to make it private), and follows the deploy. For anything else it
 * shows the edit to make where the container was started.
 */

export interface MakePrivateOutcome {
  stackId: string;
  stackName: string;
  service: string;
  revision: number | null;
  problem: string | null;
}

function OutsideDialog({
  target,
  port,
  onClose,
}: {
  target: Exclude<MakePrivateTarget, { kind: 'stack' }>;
  port: ContainerPortInfo;
  onClose: () => void;
}): React.JSX.Element {
  const change = privateChange(target, port);
  const where =
    target.kind === 'compose'
      ? `the compose project ${target.project}, which was not deployed as an app from Runova`
      : 'docker run (or another tool), not by a Runova app';
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{port.containerName} can't be changed from here</DialogTitle>
          <DialogDescription>
            It was started by {where}, so Runova cannot redeploy it. Make this change where it is
            defined and start it again. It will then answer on 127.0.0.1 only.
          </DialogDescription>
        </DialogHeader>
        <pre
          aria-label={target.kind === 'compose' ? 'Compose change' : 'Run change'}
          className={CODE_WELL}
        >
          {change}
        </pre>
        <p className="text-xs text-muted-foreground">
          To reach it from outside after that, put it on a domain in Websites, or deploy it as an
          app from its project so Runova keeps it private for you.
        </p>
        <DialogFooter>
          <Button
            variant="soft"
            onClick={() =>
              void navigator.clipboard
                .writeText(change)
                .then(() => toast.success('Change copied.'))
                .catch(() => toast.error('Could not copy the change.'))
            }
          >
            <Copy className="h-3.5 w-3.5" /> Copy the change
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The redeploy as it goes, then where public access comes from now. */
export function MakePrivateNotice({
  serverId,
  outcome,
}: {
  serverId: string;
  outcome: MakePrivateOutcome;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [, setParams] = useSearchParams();
  const watching = outcome.revision !== null && outcome.problem === null;
  const details = useStack(serverId, outcome.stackId, watching, true);
  const revision = details.data?.revisions.find((item) => item.number === outcome.revision);
  const live = revision?.state === 'live';
  const failed = revision?.state === 'failed' || revision?.state === 'invalid';
  const refreshed = useRef(false);

  useEffect(() => {
    if (!live || refreshed.current) return;
    refreshed.current = true;
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployFirewallExposure(serverId) });
  }, [live, queryClient, serverId]);

  const problem = outcome.problem ?? (failed ? (revision?.error ?? 'The deploy failed.') : null);
  return (
    <div role="status" className="basis-full text-xs">
      {problem ? (
        <p className="flex items-start gap-1.5 text-destructive">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {problem}
        </p>
      ) : live ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-success">
          <CircleCheck className="h-3 w-3 shrink-0" />
          Private now: revision {outcome.revision} of {outcome.stackName} is live with{' '}
          {outcome.service} on 127.0.0.1.
          <Button
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => setParams({ server: serverId, view: 'websites' })}
          >
            Put it on a domain in Websites
          </Button>
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Spinner className="h-3 w-3 motion-safe:animate-spin" />
          Deploying {outcome.stackName} again as revision {outcome.revision}.
          <Button
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => setParams({ server: serverId, view: 'apps', app: outcome.stackId })}
          >
            Follow it in Apps
          </Button>
        </p>
      )}
    </div>
  );
}

export function useMakePrivate(serverId: string) {
  const [checking, setChecking] = useState<string | null>(null);
  const [outside, setOutside] = useState<{
    target: Exclude<MakePrivateTarget, { kind: 'stack' }>;
    port: ContainerPortInfo;
  } | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, MakePrivateOutcome>>({});
  const [problem, setProblem] = useState<string | null>(null);

  async function start(port: ContainerPortInfo): Promise<void> {
    setChecking(port.containerId);
    setProblem(null);
    try {
      const list = await window.runova.deployDocker.listContainers(serverId);
      const container = findContainer(list, port);
      let target = classifyContainer(container, [], null);
      if (container?.composeProject) {
        const stacks = (await window.runova.deployStacks.list(serverId)) ?? [];
        const stack = stacks.find((item) => item.name === container.composeProject);
        const details = stack
          ? await window.runova.deployStacks.get({ serverId, stackId: stack.id })
          : null;
        target = classifyContainer(container, stacks, details);
      }
      if (target.kind !== 'stack') {
        setOutside({ target, port });
        return;
      }
      const { stack, service } = target;
      const ok = await confirmDialog({
        title: `Make ${service} private?`,
        description: `${stack.name} is deployed again as a new revision, with every port of ${service} on 127.0.0.1. Anything that reaches it on ${publicAddress(port)} from outside the server stops working. To serve it to the public, put it on a domain in Websites.`,
        icon: Lock,
        confirmLabel: 'Make private',
      });
      if (!ok) return;
      const base = { stackId: stack.id, stackName: stack.name, service };
      try {
        const result = await window.runova.deployStacks.makePrivate({
          serverId,
          stackId: stack.id,
          services: [service],
        });
        setOutcomes((current) => ({
          ...current,
          [port.containerName]: {
            ...base,
            revision: result.revision.number,
            problem: result.job
              ? null
              : (result.revision.error ??
                `Revision ${result.revision.number} waits for findings to be acknowledged in Apps.`),
          },
        }));
      } catch (error) {
        setOutcomes((current) => ({
          ...current,
          [port.containerName]: { ...base, revision: null, problem: coreErrorMessage(error) },
        }));
      }
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setChecking(null);
    }
  }

  return {
    start,
    checking,
    outcomes,
    problem,
    dialog: outside ? (
      <OutsideDialog target={outside.target} port={outside.port} onClose={() => setOutside(null)} />
    ) : null,
  };
}
