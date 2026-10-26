import { coreErrorMessage } from '@shared/coreErrors';
import type {
  ChecklistItem,
  SshHardeningChangeInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeploySshHardeningInput } from '@shared/deployHardeningTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  CircleCheck,
  CircleQuestion,
  CircleX,
  RefreshCw,
  Shield,
  TriangleAlert,
} from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { TwoFactorDialog } from '../../TwoFactorDialog';
import { CARD_BODY, CARD_ROWS, LoadFailure, SecurityCard } from '../SecurityCard';
import { useStepUp } from '../useStepUp';
import { FIX_LABEL, fixAllowed, STATUS_WORD } from './fixes';
import { ScoreRing } from './ScoreRing';
import { SshChangeBanner, useSshSteps } from './SshChangeBanner';
import { SshFixDialog } from './SshFixDialog';

/**
 * The Security checklist (the plan's signature interaction 5): a score, then every item with what
 * the core found and a fix. Each fix shows the exact change before it runs: SSH fixes preview the
 * drop-in and commands, the firewall goes through the Firewall section's own review and safe apply,
 * the rest say what will happen in a confirmation. None of them can lock the app out: the firewall
 * keeps the SSH guard, and SSH changes need a proven key login and are kept only over a new one.
 */

const STATUS_ICON = {
  pass: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
  unknown: CircleQuestion,
} as const;
const STATUS_TONE = {
  pass: 'success',
  warn: 'warning',
  fail: 'destructive',
  unknown: 'neutral',
} as const;

/** The status mark's tile, tinted like its chip. */
const STATUS_TILE = {
  pass: 'bg-success/12 text-success',
  warn: 'bg-warning/12 text-warning',
  fail: 'bg-destructive/12 text-destructive',
  unknown: 'bg-foreground/[0.06] text-muted-foreground',
} as const;

export function ChecklistCard({
  server,
  owner,
  admin,
  onUpdateCore,
}: {
  server: DeployServer;
  owner: boolean;
  admin: boolean;
  /** Opens the core update; absent where the app cannot install one (the DevHost). */
  onUpdateCore?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [, setParams] = useSearchParams();
  const stepUp = useStepUp(server);
  const { steps, reset } = useSshSteps(server.id);
  const [sshRequest, setSshRequest] = useState<Omit<DeploySshHardeningInput, 'serverId'> | null>(
    null,
  );
  const [applied, setApplied] = useState<SshHardeningChangeInfo | null>(null);
  const [deciding, setDeciding] = useState<'keep' | 'revert' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [twoFactor, setTwoFactor] = useState(false);
  const checklist = useQuery({
    queryKey: queryKeys.deployChecklist(server.id),
    queryFn: () => window.runova.deployHardening.checklist(server.id),
    retry: false,
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployChecklist(server.id) });
  const pending = applied ?? checklist.data?.pendingSshChange ?? null;

  // A change nobody keeps goes back on the server at its deadline (the core settles it within its
  // grace period); look again then, so the list shows what sshd runs.
  const deadline = pending?.deadlineUnixMs;
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setTimeout(
      () => {
        setApplied(null);
        void queryClient.invalidateQueries({ queryKey: queryKeys.deployChecklist(server.id) });
      },
      Math.max(0, deadline - Date.now()) + 25_000,
    );
    return () => clearTimeout(timer);
  }, [deadline, queryClient, server.id]);

  async function runFix(item: ChecklistItem): Promise<void> {
    switch (item.fix) {
      case 'enableFirewall':
        setParams(
          { server: server.id, view: 'firewall', fix: 'enable-firewall' },
          { replace: true },
        );
        return;
      case 'reviewExposure':
        setParams({ server: server.id, view: 'firewall' }, { replace: true });
        return;
      case 'reboot':
        setParams({ server: server.id }, { replace: true });
        return;
      case 'disableSshPasswordLogin':
      case 'restrictRootLogin':
        reset('apply');
        setSshRequest({
          disablePasswordLogin: item.fix === 'disableSshPasswordLogin',
          restrictRootLogin: item.fix === 'restrictRootLogin',
        });
        return;
      case 'updateCore':
        onUpdateCore?.();
        return;
      case 'enableTwoFactor':
        setTwoFactor(true);
        return;
      case 'enableAutomaticUpdates': {
        const confirmed = await confirmDialog({
          title: 'Turn on automatic security updates?',
          description:
            'The core installs unattended-upgrades (Ubuntu and Debian) or dnf-automatic (RHEL, Rocky, Alma) if it is missing, and has it install security updates by itself every day. It runs as a job you can follow in Overview. SSH and the app keep working while it runs.',
          confirmLabel: 'Turn on',
        });
        if (!confirmed) return;
        await act(
          () => window.runova.deploySystem.setAutomaticUpdates(server.id, true),
          'Turning on automatic security updates. Follow the job in Overview.',
        );
        return;
      }
      case 'renewCertificates': {
        const confirmed = await confirmDialog({
          title: 'Renew these certificates now?',
          description:
            "Each one is ordered again from Let's Encrypt over HTTP. The sites keep serving the current certificate until the new one is in.",
          items: item.targets.map((site) => ({ name: site })),
          confirmLabel: 'Renew now',
        });
        if (!confirmed) return;
        await act(
          () =>
            Promise.all(
              item.targets.map((site) => window.runova.deployCerts.renew(server.id, site)),
            ),
          'Renewing. Each renewal is a job you can follow in Websites.',
        );
        return;
      }
      default:
        return;
    }
  }

  async function act(work: () => Promise<unknown>, success: string): Promise<void> {
    try {
      await work();
      toast.success(success);
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      refresh();
    }
  }

  async function decide(kind: 'keep' | 'revert', change: SshHardeningChangeInfo): Promise<void> {
    setDeciding(kind);
    setProblem(null);
    reset('confirm');
    reset('revert');
    try {
      const input = { serverId: server.id, changeId: change.id };
      if (kind === 'keep') {
        await window.runova.deployHardening.confirmSsh(input);
        toast.success('SSH change kept. New logins need a key now.');
      } else {
        await window.runova.deployHardening.revertSsh(input);
        toast.success('SSH change reverted. The old settings are back.');
      }
      setApplied(null);
      refresh();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setDeciding(null);
    }
  }

  let body: React.ReactNode;
  if (checklist.isPending) {
    body = (
      <div aria-busy="true">
        <div className={cn(CARD_BODY, 'flex items-center gap-6')}>
          <Skeleton className="h-[132px] w-[132px] rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
        <div className={CARD_ROWS}>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-7 w-7 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
              <Skeleton className="h-7 w-24 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    );
  } else if (checklist.isError) {
    body = (
      <LoadFailure
        message={coreErrorMessage(checklist.error)}
        onRetry={() => void checklist.refetch()}
      />
    );
  } else {
    const { items, score } = checklist.data;
    const open = items.filter((item) => item.status === 'fail' || item.status === 'warn').length;
    body = (
      <>
        <div className={cn(CARD_BODY, 'flex flex-wrap items-center gap-6')}>
          <ScoreRing score={score} items={items} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-lg font-semibold tracking-tight text-foreground">
              {open === 0
                ? 'Nothing left to fix'
                : `${open} ${open === 1 ? 'thing' : 'things'} to fix`}
            </p>
            <p className="text-sm text-muted-foreground">
              Each arc of the ring is one item, sized by how much it matters. Runs core{' '}
              {checklist.data.coreVersion}.
            </p>
          </div>
        </div>
        {pending && (
          <div className={CARD_BODY}>
            <SshChangeBanner
              change={pending}
              windowSeconds={Math.max(
                1,
                Math.round((pending.deadlineUnixMs - pending.createdAtUnixMs) / 1000),
              )}
              busy={deciding}
              steps={deciding === 'revert' ? steps.revert : steps.confirm}
              problem={problem}
              canDecide={owner}
              onKeep={() => void decide('keep', pending)}
              onRevert={() => void decide('revert', pending)}
            />
          </div>
        )}
        <ul aria-label="Checklist" className={CARD_ROWS}>
          {items.map((item) => {
            const Icon = STATUS_ICON[item.status];
            const permission = fixAllowed(item.fix, { owner, admin });
            const hidden = item.fix === 'none' || (item.fix === 'updateCore' && !onUpdateCore);
            const sshBusy =
              (item.fix === 'disableSshPasswordLogin' || item.fix === 'restrictRootLogin') &&
              pending !== null;
            return (
              <li
                key={item.id}
                aria-label={`${item.title}: ${STATUS_WORD[item.status]}`}
                className="flex flex-wrap items-start gap-3 px-4 py-3"
              >
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                    STATUS_TILE[item.status],
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-[min(100%,14rem)] flex-1 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-foreground">
                    {item.title}
                    <Chip tone={STATUS_TONE[item.status]}>{STATUS_WORD[item.status]}</Chip>
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
                </div>
                {!hidden && item.fix !== 'none' && (
                  <SimpleTooltip
                    label={
                      !permission.allowed
                        ? permission.why
                        : sshBusy
                          ? 'An SSH change waits to be kept or reverted.'
                          : undefined
                    }
                    wrapTrigger
                  >
                    <Button
                      size="sm"
                      variant={item.status === 'fail' ? 'default' : 'soft'}
                      disabled={!permission.allowed || sshBusy}
                      onClick={() => void runFix(item)}
                    >
                      {FIX_LABEL[item.fix]}
                    </Button>
                  </SimpleTooltip>
                )}
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <SecurityCard
      icon={<Shield />}
      title="Security checklist"
      description={`How safe ${server.nickname} is, and what each fix will change before it runs.`}
      actions={
        <Button
          size="sm"
          variant="soft"
          disabled={checklist.isFetching}
          onClick={() => void checklist.refetch()}
        >
          <RefreshCw
            className={cn('h-3.5 w-3.5', checklist.isFetching && 'motion-safe:animate-spin')}
          />{' '}
          Check again
        </Button>
      }
    >
      {body}
      <SshFixDialog
        server={server}
        request={sshRequest}
        stepUp={stepUp}
        steps={steps.apply}
        onOpenChange={(open) => !open && setSshRequest(null)}
        onApplied={(change) => {
          setSshRequest(null);
          setApplied(change);
          reset('confirm');
          refresh();
        }}
      />
      <TwoFactorDialog
        server={server}
        mode="on"
        open={twoFactor}
        onOpenChange={setTwoFactor}
        onChanged={refresh}
      />
      {stepUp.dialog}
    </SecurityCard>
  );
}
