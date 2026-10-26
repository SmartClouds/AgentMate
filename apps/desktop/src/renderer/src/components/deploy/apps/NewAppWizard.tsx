import { validateStackName } from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type {
  JobInfo,
  StackDetails,
  StackRevisionInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployStackUploadProgress, DeployStackUploadResult } from '@shared/deployStacksTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Problem } from '@/components/cloudflare/fields';
import { ArrowLeft, ArrowRight, Check, Rocket, Spinner, Upload } from '@/components/icons';
import { FOOTER_HAIRLINE, GLASS_CARD, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { folderName, needsAcknowledgment, suggestAppName } from '@/lib/deploy/apps/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { RegistryPlanCard } from '../registries/RegistryPlanCard';
import { DeployTimeline } from './DeployTimeline';
import { type AppsAccess, useStack, useStacks } from './hooks';
import { ConfigureStep } from './wizard/ConfigureStep';
import { ExposeStep } from './wizard/ExposeStep';
import { RiskList } from './wizard/RiskList';
import { SourceStep } from './wizard/SourceStep';
import { WIZARD_STEPS, type WizardSource, type WizardStep } from './wizard/types';

/**
 * The New App wizard (E07 T7): a project and its compose file and environment, what it runs,
 * who can reach its ports, the risks to accept, then the deploy itself as a live timeline. The
 * same wizard deploys an existing app again from where it came from, as a new revision.
 */

type Run =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'invalid'; result: DeployStackUploadResult }
  | { phase: 'confirm'; result: DeployStackUploadResult }
  | { phase: 'starting'; result: DeployStackUploadResult }
  | { phase: 'running'; result: DeployStackUploadResult; job: JobInfo }
  | { phase: 'error'; message: string; result?: DeployStackUploadResult };

const UPLOAD_TEXT: Record<DeployStackUploadProgress['phase'], string> = {
  reading: 'Reading the compose file and the environment',
  packing: 'Packing the project folder',
  'uploading-files': 'Sending the files to the server',
  'uploading-context': 'Sending the project folder to the server',
  done: 'The server is checking the files',
};

function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function initialSource(existing: StackDetails | undefined): WizardSource {
  const source = existing?.stack.source;
  return {
    projectId: source?.projectId ?? '',
    projectName: source?.projectName ?? '',
    projectFolder: '',
    composePath: source?.composePath ?? '',
    environmentId: source?.environmentId ?? null,
    environmentName: source?.environmentName ?? null,
    name: existing?.stack.name ?? '',
  };
}

function StepNav({
  current,
  reached,
  onGo,
}: {
  current: WizardStep;
  reached: number;
  onGo: (step: WizardStep) => void;
}): React.JSX.Element {
  const index = WIZARD_STEPS.findIndex((item) => item.step === current);
  return (
    <ol aria-label="New app steps" className="flex flex-wrap items-center gap-1 text-xs">
      {WIZARD_STEPS.map((item, position) => {
        const done = position < index;
        const here = position === index;
        const reachable = position <= reached && current !== 'deploy' && item.step !== 'deploy';
        return (
          <li
            key={item.step}
            aria-current={here ? 'step' : undefined}
            className="flex items-center gap-1"
          >
            {position > 0 && <span aria-hidden="true" className="h-px w-4 bg-foreground/[0.12]" />}
            <button
              type="button"
              disabled={!reachable || here}
              onClick={() => onGo(item.step)}
              className={cn(
                // Inset rings, since a tinted border would lose to the global border colour.
                'flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
                here && 'bg-primary/12 font-medium text-primary ring-primary/30',
                done && 'text-foreground ring-success/30 enabled:hover:bg-foreground/[0.06]',
                !here && !done && 'text-muted-foreground ring-foreground/[0.08]',
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold',
                  here
                    ? 'bg-primary text-primary-foreground'
                    : done
                      ? 'bg-success/20 text-success'
                      : 'bg-foreground/[0.08]',
                )}
              >
                {done ? <Check className="h-2.5 w-2.5" /> : position + 1}
              </span>
              {item.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function RunningDeploy({
  serverId,
  access,
  result,
  job,
  onSettled,
}: {
  serverId: string;
  access: AppsAccess;
  result: DeployStackUploadResult;
  job: JobInfo;
  onSettled: () => void;
}): React.JSX.Element {
  const details = useStack(serverId, result.stack.id, true, true);
  const known = details.data?.revisions.find((item) => item.number === result.revision.number);
  const revision: StackRevisionInfo = known ?? {
    ...result.revision,
    state: 'deploying',
    jobId: job.id,
  };
  return (
    <DeployTimeline
      serverId={serverId}
      revision={revision.jobId ? revision : { ...revision, jobId: job.id }}
      canOperate={access.canOperate}
      onSettled={onSettled}
      flat
    />
  );
}

export function NewAppWizard({
  serverId,
  access,
  existing,
  onCancel,
  onOpenApp,
}: {
  serverId: string;
  access: AppsAccess;
  /** Deploy this app again, from the project it came from. */
  existing?: StackDetails;
  onCancel: () => void;
  onOpenApp: (stackId: string) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>('source');
  const [reached, setReached] = useState(0);
  const [source, setSource] = useState<WizardSource>(() => initialSource(existing));
  const [nameTouched, setNameTouched] = useState(existing !== undefined);
  // Deploying again starts from what the app runs now; a new app from the preview's default.
  const [proxied, setProxied] = useState<string[] | undefined>(
    existing?.revisions[0]?.proxiedServices,
  );
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [serverAcknowledged, setServerAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [run, setRun] = useState<Run>({ phase: 'idle' });
  const [progress, setProgress] = useState<DeployStackUploadProgress | null>(null);
  const apps = useStacks(serverId, access.signedIn && !existing);

  useEffect(
    () =>
      window.runova.deployStacks.onUploadProgress((event) => {
        if (event.serverId === serverId) setProgress(event);
      }),
    [serverId],
  );

  const ready = source.projectId !== '' && source.composePath !== '';
  const previewInput = useMemo(
    () => ({
      projectId: source.projectId,
      composePath: source.composePath,
      environmentId: source.environmentId,
      ...(proxied ? { proxiedServices: proxied } : {}),
    }),
    [source.projectId, source.composePath, source.environmentId, proxied],
  );
  const preview = useQuery({
    queryKey: queryKeys.deployAppPreview(previewInput),
    queryFn: () => window.runova.deployStacks.preview(previewInput),
    enabled: ready && step !== 'source',
    retry: false,
    placeholderData: (previous) => previous,
  });
  const data = preview.data;

  // The first preview decides which services stay private; later ones follow the switches.
  useEffect(() => {
    if (data && proxied === undefined) setProxied(data.proxiedServices);
  }, [data, proxied]);
  // A name from the compose file beats the folder name, until the person types their own.
  useEffect(() => {
    if (!nameTouched && data?.composeName) {
      const suggested = suggestAppName(data.composeName);
      if (suggested) setSource((current) => ({ ...current, name: suggested }));
    }
  }, [data?.composeName, nameTouched]);

  const nameCheck = validateStackName(source.name);
  const taken =
    !existing && (apps.data ?? []).some((app) => app.name === source.name)
      ? `An app called ${source.name} is already on this server. Pick another name, or deploy that app again from its page.`
      : null;
  const nameProblem = source.name === '' ? null : nameCheck.ok ? taken : nameCheck.reason;

  const requires = (data?.requiresAcknowledgment ?? []).filter((id) =>
    data?.risks.some((risk) => risk.id === id),
  );
  const allAccepted = requires.every((id) => acknowledged.has(id));

  function change(next: Partial<WizardSource>, touchedName = false): void {
    setSource((current) => {
      const merged = { ...current, ...next };
      if (!nameTouched && !touchedName && next.projectId !== undefined) {
        merged.name = suggestAppName(merged.projectName || folderName(merged.projectFolder));
      }
      return merged;
    });
    if (touchedName) setNameTouched(true);
    if (next.projectId !== undefined || next.composePath !== undefined) {
      setProxied(undefined);
      setAcknowledged(new Set());
      setReached(0);
    }
  }

  function go(next: WizardStep): void {
    const index = WIZARD_STEPS.findIndex((item) => item.step === next);
    setReached((current) => Math.max(current, index));
    setStep(next);
  }

  const settled = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployApps(serverId) });
  }, [queryClient, serverId]);

  async function launch(result: DeployStackUploadResult, accept: readonly string[] = []) {
    setRun({ phase: 'starting', result });
    try {
      if (accept.length > 0) {
        await window.runova.deployStacks.acknowledge({
          serverId,
          stackId: result.stack.id,
          revision: result.revision.number,
          riskIds: [...accept],
        });
      }
      const job = await window.runova.deployStacks.deploy({
        serverId,
        stackId: result.stack.id,
        revision: result.revision.number,
      });
      setRun({ phase: 'running', result, job });
      settled();
    } catch (error) {
      setRun({ phase: 'error', message: coreErrorMessage(error), result });
    }
  }

  async function startDeploy(): Promise<void> {
    go('deploy');
    setProgress(null);
    setRun({ phase: 'uploading' });
    const common = {
      serverId,
      projectId: source.projectId,
      composePath: source.composePath,
      environmentId: source.environmentId,
      proxiedServices: proxied ?? data?.proxiedServices ?? [],
      acknowledgedRisks: requires.filter((id) => acknowledged.has(id)),
    };
    let result: DeployStackUploadResult;
    try {
      result = existing
        ? await window.runova.deployStacks.upload({ ...common, stackId: existing.stack.id })
        : await window.runova.deployStacks.create({ ...common, name: source.name });
    } catch (error) {
      setRun({ phase: 'error', message: coreErrorMessage(error) });
      return;
    }
    settled();
    if (result.revision.state === 'invalid') {
      setRun({ phase: 'invalid', result });
    } else if (result.revision.unacknowledgedRisks.length > 0) {
      setServerAcknowledged(new Set());
      setRun({ phase: 'confirm', result });
    } else {
      await launch(result);
    }
  }

  const title = existing ? `Deploy ${existing.stack.name} again` : 'New app';
  const deploying = step === 'deploy';

  let body: React.ReactNode;
  let next: React.ReactNode = null;
  if (step === 'source') {
    body = (
      <SourceStep
        source={source}
        nameProblem={nameProblem}
        nameLocked={existing !== undefined}
        onChange={change}
      />
    );
    next = (
      <Button disabled={!ready || !nameCheck.ok || taken !== null} onClick={() => go('configure')}>
        Next <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    );
  } else if (!deploying && (preview.isPending || !data)) {
    body = preview.isError ? (
      <Problem
        message={`The compose file could not be read: ${coreErrorMessage(preview.error)}`}
        onRetry={() => void preview.refetch()}
      />
    ) : (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  } else if (step === 'configure' && data) {
    body = <ConfigureStep preview={data} />;
    next = (
      <Button disabled={data.blocking !== null} onClick={() => go('expose')}>
        Next <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    );
  } else if (step === 'expose' && data) {
    body = (
      <ExposeStep
        preview={data}
        proxied={proxied ?? data.proxiedServices}
        updating={preview.isFetching}
        onToggle={(service, keepPrivate) =>
          setProxied((current) => {
            const list = current ?? data.proxiedServices;
            return keepPrivate
              ? [...new Set([...list, service])]
              : list.filter((name) => name !== service);
          })
        }
      />
    );
    next = (
      <Button disabled={preview.isFetching || data.blocking !== null} onClick={() => go('review')}>
        Next <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    );
  } else if (step === 'review' && data) {
    const left = requires.filter((id) => !acknowledged.has(id)).length;
    body = (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {requires.length === 0
            ? 'Nothing here needs your say-so. Low findings are listed as advice.'
            : `Accept each finding below to deploy. Each one you accept is recorded in the server's audit trail.`}
        </p>
        <RiskList
          label="Findings to accept"
          risks={data.risks}
          requires={requires}
          acknowledged={acknowledged}
          onAcknowledge={(id, accepted) =>
            setAcknowledged((current) => {
              const nextSet = new Set(current);
              if (accepted) nextSet.add(id);
              else nextSet.delete(id);
              return nextSet;
            })
          }
        />
        {left > 0 && (
          <p role="status" className="text-xs text-warning">
            {left === 1
              ? '1 finding still needs accepting.'
              : `${left} findings still need accepting.`}
          </p>
        )}
        <RegistryPlanCard
          input={{
            serverId,
            stackId: existing?.stack.id ?? null,
            images: data.services
              .filter((service) => !service.builds && service.image)
              .map((service) => service.image as string),
          }}
          stackId={null}
        />
      </div>
    );
    next = (
      <Button
        disabled={!allAccepted || !access.canOperate || data.blocking !== null}
        onClick={() => void startDeploy()}
      >
        <Rocket className="h-3.5 w-3.5" /> Deploy {source.name}
      </Button>
    );
  } else {
    body = (
      <DeployStepBody
        serverId={serverId}
        access={access}
        run={run}
        progress={progress}
        serverAcknowledged={serverAcknowledged}
        setServerAcknowledged={setServerAcknowledged}
        onLaunch={(result, accept) => void launch(result, accept)}
        onRetry={() => {
          if (run.phase === 'error' && run.result) void launch(run.result);
          else void startDeploy();
        }}
        onBack={() => {
          setRun({ phase: 'idle' });
          setStep('review');
        }}
        onSettled={settled}
      />
    );
    const stackId =
      run.phase === 'running' || run.phase === 'invalid' || run.phase === 'confirm'
        ? run.result.stack.id
        : run.phase === 'error'
          ? run.result?.stack.id
          : undefined;
    next = stackId ? (
      <Button onClick={() => onOpenApp(stackId)}>
        Open the app <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    ) : null;
  }

  const index = WIZARD_STEPS.findIndex((item) => item.step === step);
  const previous = index > 0 && !deploying ? WIZARD_STEPS[index - 1].step : null;

  return (
    <section aria-labelledby="new-app-heading" className="flex flex-col gap-2">
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-3 px-4 py-3')}>
        <h3 id="new-app-heading" className="min-w-0 flex-1 text-sm font-semibold text-foreground">
          {title}
        </h3>
        <StepNav current={step} reached={reached} onGo={setStep} />
      </div>
      <div className={GLASS_CARD}>
        <div className="p-4">
          <h4 className={cn(SECTION_HEADING, 'mb-3')}>{WIZARD_STEPS[index].label}</h4>
          {body}
        </div>
        <div className={cn('flex flex-wrap items-center gap-2 px-4 py-3', FOOTER_HAIRLINE)}>
          {!deploying || run.phase === 'error' || run.phase === 'invalid' ? (
            <Button variant="soft" onClick={onCancel}>
              {deploying ? 'Close' : 'Cancel'}
            </Button>
          ) : (
            <Button variant="soft" onClick={onCancel}>
              Back to the apps
            </Button>
          )}
          <span className="flex-1" />
          {previous && (
            <Button variant="soft" onClick={() => setStep(previous)}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Button>
          )}
          {next}
        </div>
      </div>
    </section>
  );
}

function DeployStepBody({
  serverId,
  access,
  run,
  progress,
  serverAcknowledged,
  setServerAcknowledged,
  onLaunch,
  onRetry,
  onBack,
  onSettled,
}: {
  serverId: string;
  access: AppsAccess;
  run: Run;
  progress: DeployStackUploadProgress | null;
  serverAcknowledged: ReadonlySet<string>;
  setServerAcknowledged: (next: ReadonlySet<string>) => void;
  onLaunch: (result: DeployStackUploadResult, accept: readonly string[]) => void;
  onRetry: () => void;
  onBack: () => void;
  onSettled: () => void;
}): React.JSX.Element {
  if (run.phase === 'idle' || run.phase === 'uploading' || run.phase === 'starting') {
    const sending = progress?.phase === 'uploading-context' && progress.totalBytes;
    const percent = sending
      ? Math.min(100, Math.round(((progress.sentBytes ?? 0) / (progress.totalBytes ?? 1)) * 100))
      : null;
    return (
      <div role="status" className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-foreground">
          {run.phase === 'starting' ? (
            <Spinner className="h-4 w-4 motion-safe:animate-spin" />
          ) : (
            <Upload className="h-4 w-4 text-primary" />
          )}
          {run.phase === 'starting'
            ? 'Starting the deploy'
            : progress
              ? UPLOAD_TEXT[progress.phase]
              : 'Getting the files ready'}
          …
        </p>
        {percent !== null && progress && (
          <div className="space-y-1">
            <div
              role="progressbar"
              aria-label="Upload"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
            >
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              {describeBytes(progress.sentBytes ?? 0)} of {describeBytes(progress.totalBytes ?? 0)}
            </p>
          </div>
        )}
      </div>
    );
  }
  if (run.phase === 'error') {
    return <Problem message={run.message} onRetry={onRetry} />;
  }
  if (run.phase === 'invalid') {
    return (
      <div className="space-y-3">
        <Problem
          message={`The server turned the compose file down: ${run.result.revision.error ?? 'docker compose config refused it.'}`}
        />
        <p className="text-xs text-muted-foreground">
          Revision {run.result.revision.number} is kept as invalid. Fix the file in the project and
          deploy again.
        </p>
        <Button size="sm" variant="soft" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back to the review
        </Button>
      </div>
    );
  }
  if (run.phase === 'confirm') {
    const { revision } = run.result;
    const pending = revision.findings.filter((finding) =>
      revision.unacknowledgedRisks.includes(finding.id),
    );
    const ids = pending.filter((finding) => needsAcknowledgment(finding)).map((f) => f.id);
    const all = ids.every((id) => serverAcknowledged.has(id));
    return (
      <div className="space-y-4">
        <p className="text-sm text-foreground">
          The server checked the files as Docker Compose reads them and found more to accept before
          it deploys.
        </p>
        <RiskList
          label="Server findings to accept"
          risks={pending.map((finding) => ({
            id: finding.id,
            severity: finding.severity,
            message: finding.message,
            service: finding.service,
          }))}
          requires={ids}
          acknowledged={serverAcknowledged}
          onAcknowledge={(id, accepted) => {
            const next = new Set(serverAcknowledged);
            if (accepted) next.add(id);
            else next.delete(id);
            setServerAcknowledged(next);
          }}
        />
        <Button disabled={!all || !access.canOperate} onClick={() => onLaunch(run.result, ids)}>
          <Rocket className="h-3.5 w-3.5" /> Accept and deploy
        </Button>
      </div>
    );
  }
  return (
    <RunningDeploy
      serverId={serverId}
      access={access}
      result={run.result}
      job={run.job}
      onSettled={onSettled}
    />
  );
}
