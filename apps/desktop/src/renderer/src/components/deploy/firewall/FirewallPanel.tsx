import { coreErrorMessage } from '@shared/coreErrors';
import type { RuleDraft } from '@shared/deploy/firewallValidation';
import type {
  FirewallChange,
  FirewallChangeSetInfo,
  FirewallPreset,
  FirewallRuleInfo,
  FirewallRuleSpec,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { OriginLockCard } from '@/components/cloudflare/server/OriginLockCard';
import { Skeleton } from '@/components/ui/skeleton';
import { draftFromRule } from '@/lib/deploy/firewall/format';
import { missingRules, takeFirewallRules } from '@/lib/deploy/firewall/restoredRules';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { CoreAccessCard } from '../CoreAccessCard';
import { useDeployConnection } from '../overview/hooks';
import { useProofStepUp } from '../overview/useProofStepUp';
import { hasRole } from '../security/format';
import { SECURITY_CARD } from '../security/SecurityCard';
import { ApplyDialog } from './ApplyDialog';
import { CountdownBanner } from './CountdownBanner';
import { ExposureCard } from './ExposureCard';
import { HistoryCard } from './HistoryCard';
import { useFirewallData, useFirewallSteps, useTicking } from './hooks';
import { useMakePrivate } from './MakePrivate';
import { PresetsCard } from './PresetsCard';
import { RuleDialog } from './RuleDialog';
import { RulesCard } from './RulesCard';
import { StagedChanges } from './StagedChanges';
import { StatusHero } from './StatusHero';

/**
 * A server's Firewall section (E13). Changes are staged here, reviewed with the exact commands
 * and the SSH guard's verdict, and applied as one change set. The change is then live but on
 * probation: the banner counts down, Keep confirms it over a brand-new SSH connection, Revert
 * puts the old rules back, and at zero the server rolls it back by itself. Everyone reads;
 * Admins change. The core checks every call again.
 */

interface Staged {
  change: FirewallChange;
  /** The rule an edit replaces, so taking the edit back drops both halves. */
  editOf?: string;
}

interface RuleForm {
  initial: RuleDraft;
  editOf?: string;
  sourceHint?: string;
}

const message = (error: unknown) => (error ? coreErrorMessage(error) : null);

export function FirewallPanel({ server }: { server: DeployServer }): React.JSX.Element {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const access = useQuery({
    queryKey: queryKeys.deployAccess(serverId),
    queryFn: () => window.runova.deploy.access(serverId),
    retry: false,
    staleTime: 30_000,
  });
  const signedIn = access.data?.state === 'signed-in';
  const canAdmin = hasRole(access.data?.user?.roles, 'admin');
  const canOperate = hasRole(access.data?.user?.roles, 'operator');
  const makePrivate = useMakePrivate(serverId);
  const connection = useDeployConnection(serverId, signedIn);
  const stale = connection?.state === 'reconnecting';
  const { status, presets, history, exposure } = useFirewallData(serverId, signedIn);
  const { steps, reset } = useFirewallSteps(serverId);
  const stepUp = useProofStepUp(server);

  const [staged, setStaged] = useState<Staged[]>([]);
  const [form, setForm] = useState<RuleForm | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [deciding, setDeciding] = useState<'keep' | 'revert' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pending = status.data?.pending;
  const now = useTicking(pending !== undefined);
  const rules = status.data?.rules ?? [];
  const canEdit = canAdmin && !pending && !stale;
  const removing = useMemo(
    () =>
      new Set(
        staged.flatMap((item) =>
          item.change.kind === 'removeRule' && item.change.ruleId ? [item.change.ruleId] : [],
        ),
      ),
    [staged],
  );

  const stagedIncoming = staged.find((item) => item.change.kind === 'setDefaultIncoming')?.change
    .policy;

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployFirewall(serverId) });

  // Say so when a change that was waiting ends without this window deciding it. The status
  // can hear of the end before the history does, so this waits for the history to say how.
  const waitingFor = useRef<string | null>(null);
  const historyData = history.data;
  useEffect(() => {
    if (pending) {
      waitingFor.current = pending.id;
      return;
    }
    const id = waitingFor.current;
    if (!id || deciding) return;
    const ended = historyData?.find((change) => change.id === id);
    if (!ended || ended.state === 'awaitingConfirmation' || ended.state === 'applying') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployFirewallHistory(serverId) });
      return;
    }
    waitingFor.current = null;
    if (ended.state === 'rolledBack' && ended.rolledBackBy === 'timer') {
      toast.warning('Nobody kept the firewall change in time, so the old rules are back.');
    }
  }, [pending, historyData, deciding, queryClient, serverId]);

  function stage(...items: Staged[]): void {
    setStaged((current) => [...current, ...items]);
  }

  function saveRule(rule: FirewallRuleSpec): void {
    const editOf = form?.editOf;
    if (editOf) {
      stage(
        { change: { kind: 'removeRule', ruleId: editOf }, editOf },
        { change: { kind: 'addRule', rule }, editOf },
      );
    } else {
      stage({ change: { kind: 'addRule', rule } });
    }
  }

  function pickPreset(preset: FirewallPreset): void {
    const [first] = preset.rules;
    if (preset.suggestSource && first && preset.rules.length === 1) {
      setForm({
        initial: {
          ...draftFromRule(),
          ports: first.port ? String(first.port) : '',
          protocol: first.protocol,
        },
        sourceHint: `${preset.name} is best kept to your own network, such as 10.0.0.0/8.`,
      });
      return;
    }
    stage(...preset.rules.map((rule) => ({ change: { kind: 'addRule' as const, rule } })));
  }

  async function toggle(on: boolean): Promise<void> {
    if (!on) {
      const confirmed = await confirmDialog({
        title: `Turn off the firewall on ${server.nickname}?`,
        description:
          'Every port that listens becomes reachable from anywhere, including databases and admin panels.',
        warning: 'Type the server name to confirm. You review the change before it applies.',
        confirmLabel: 'Stage turning it off',
        variant: 'destructive',
        typeToConfirm: server.nickname,
      });
      if (!confirmed) return;
    }
    stage({ change: { kind: on ? 'enable' : 'disable' } });
    reset('apply');
    setReviewing(true);
  }

  function applied(change: FirewallChangeSetInfo): void {
    setReviewing(false);
    setStaged([]);
    setProblem(null);
    reset('confirm');
    reset('revert');
    queryClient.setQueryData(
      queryKeys.deployFirewallStatus(serverId),
      (current: typeof status.data) => (current ? { ...current, pending: change } : current),
    );
    refresh();
  }

  async function decide(kind: 'keep' | 'revert', change: FirewallChangeSetInfo): Promise<void> {
    setDeciding(kind);
    setProblem(null);
    reset('confirm');
    reset('revert');
    try {
      const input = { serverId, changeSetId: change.id };
      if (kind === 'keep') {
        await window.runova.deployFirewall.confirm(input);
        toast.success('Firewall change kept.');
      } else {
        await window.runova.deployFirewall.revert(input);
        toast.success('Firewall change reverted. The old rules are back.');
      }
      waitingFor.current = null;
    } catch (error) {
      // The change still waits; the server's timer still undoes it at the deadline.
      setProblem(coreErrorMessage(error));
    } finally {
      setDeciding(null);
      refresh();
    }
  }

  // The Security checklist's "Turn on the firewall" lands here: SSH's own rules are staged first
  // where the firewall lacks them, then turning it on, and the usual review opens with the exact
  // commands and the lockout guard's verdict. Applying is the usual safe apply.
  const [params, setParams] = useSearchParams();
  const fixAsked = params.get('fix') === 'enable-firewall';
  useEffect(() => {
    if (!fixAsked || !status.data || !presets.data) return;
    const next = new URLSearchParams(params);
    next.delete('fix');
    setParams(next, { replace: true });
    if (!canAdmin || status.data.active || status.data.pending || !status.data.installed) return;
    const ssh = presets.data.find((preset) => preset.id === 'ssh')?.rules ?? [];
    const missing = ssh.filter(
      (wanted) =>
        !status.data?.rules.some(
          (rule) =>
            rule.action === 'allow' &&
            !rule.source &&
            !rule.outgoing &&
            rule.port === wanted.port &&
            (rule.protocol === wanted.protocol || rule.protocol === 'any'),
        ),
    );
    setStaged((current) => [
      ...current,
      ...missing.map((rule) => ({ change: { kind: 'addRule' as const, rule } })),
      { change: { kind: 'enable' as const } },
    ]);
    reset('apply');
    setReviewing(true);
  }, [fixAsked, status.data, presets.data, canAdmin, params, setParams, reset]);

  // A restore from Backups (E28) offers the backup's rules here: the ones the firewall lacks are
  // staged and the usual review opens. Applying them is the usual safe apply and keep.
  const restoreAsked = params.get('fix') === 'restore-rules';
  useEffect(() => {
    if (!restoreAsked || !status.data) return;
    const next = new URLSearchParams(params);
    next.delete('fix');
    setParams(next, { replace: true });
    const rules = missingRules(takeFirewallRules(serverId), status.data.rules);
    if (!canAdmin || status.data.pending || rules.length === 0) return;
    setStaged((current) => [
      ...current,
      ...rules.map((rule) => ({ change: { kind: 'addRule' as const, rule } })),
    ]);
    reset('apply');
    setReviewing(true);
  }, [restoreAsked, status.data, canAdmin, params, setParams, reset, serverId]);

  if (access.isPending) {
    return (
      // Each card shimmers in its own spot, the way the loaded page lays them out.
      <div className="space-y-2" aria-busy="true">
        <div className={cn(SECURITY_CARD, 'flex items-center gap-3 p-4')}>
          <Skeleton className="h-12 w-12 rounded-2xl" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
        <div className={cn(SECURITY_CARD, 'space-y-3 p-4')}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    );
  }
  if (!signedIn) {
    return (
      <div className="space-y-2">
        <p className="px-1 text-sm text-muted-foreground">
          Sign in to see the firewall on {server.nickname}.
        </p>
        <CoreAccessCard server={server} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {pending && (
        <CountdownBanner
          change={pending}
          windowSeconds={status.data?.confirmWithinSeconds ?? 60}
          now={now}
          busy={deciding}
          steps={steps.revert.length > 0 ? steps.revert : steps.confirm}
          problem={problem}
          canDecide={canAdmin}
          onKeep={() => void decide('keep', pending)}
          onRevert={() => void decide('revert', pending)}
        />
      )}
      <StatusHero
        status={status.data}
        loading={status.isPending}
        error={message(status.error)}
        stale={stale}
        canAdmin={canAdmin}
        busy={!!pending || stale}
        onToggle={(on) => void toggle(on)}
        stagedIncoming={stagedIncoming}
        onDefaultIncoming={(policy) =>
          setStaged((current) => [
            ...current.filter((item) => item.change.kind !== 'setDefaultIncoming'),
            ...(policy === status.data?.defaultIncoming
              ? []
              : [{ change: { kind: 'setDefaultIncoming' as const, policy } }]),
          ])
        }
      />
      <StagedChanges
        changes={staged.map((item) => item.change)}
        rules={rules}
        onDrop={(index) => setStaged((current) => current.filter((_, at) => at !== index))}
        onDiscard={() => setStaged([])}
        onReview={() => {
          reset('apply');
          setReviewing(true);
        }}
      />
      <RulesCard
        rules={status.data?.rules}
        loading={status.isPending}
        canEdit={canEdit}
        removing={removing}
        onAdd={() => setForm({ initial: draftFromRule() })}
        onEdit={(rule: FirewallRuleInfo) =>
          setForm({ initial: draftFromRule(rule), editOf: rule.id })
        }
        onRemove={(rule) => stage({ change: { kind: 'removeRule', ruleId: rule.id } })}
        onKeep={(rule) =>
          setStaged((current) =>
            current.filter((item) => item.editOf !== rule.id && item.change.ruleId !== rule.id),
          )
        }
      />
      <div className="grid items-start gap-2 xl:grid-cols-2">
        <PresetsCard
          presets={presets.data}
          rules={rules}
          loading={presets.isPending}
          canEdit={canEdit}
          onPick={pickPreset}
        />
        <HistoryCard
          changes={history.data}
          loading={history.isPending}
          error={message(history.error)}
          now={now}
        />
      </div>
      <ExposureCard
        exposure={exposure.data}
        loading={exposure.isPending}
        error={message(exposure.error)}
        actions={{
          serverId,
          canOperate,
          checking: makePrivate.checking,
          problem: makePrivate.problem,
          outcomes: makePrivate.outcomes,
          onMakePrivate: (port) => void makePrivate.start(port),
        }}
      />
      <OriginLockCard
        serverId={serverId}
        serverName={server.nickname}
        signedIn={signedIn}
        canAdmin={canAdmin}
        busy={!!pending || stale}
        onApplied={applied}
      />
      {makePrivate.dialog}

      <RuleDialog
        open={form !== null}
        initial={form?.initial ?? draftFromRule()}
        editing={!!form?.editOf}
        sourceHint={form?.sourceHint}
        onOpenChange={(open) => !open && setForm(null)}
        onSave={saveRule}
      />
      <ApplyDialog
        open={reviewing}
        serverId={serverId}
        changes={staged.map((item) => item.change)}
        stepUp={stepUp}
        steps={steps.apply}
        onOpenChange={setReviewing}
        onApplied={applied}
      />
      {stepUp.dialog}
    </div>
  );
}
