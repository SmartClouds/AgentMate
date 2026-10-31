import { compareVersions } from '@runova/core';
import type { PackageManagerSection, RuntimeTarget } from '@shared/apiTypes';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, Check, Cpu, ExternalLink, Spinner } from '@/components/icons';
import { bumpKind, runtimeLabel } from '@/components/projects/packagesCopy';
import {
  devSetupLink,
  toolchainName,
  useToolchainStatus,
} from '@/components/projects/useToolchainStatus';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The runtime part of a Packages section: the tool this machine builds the section with, and the
 * runtime versions the project itself declares (an SDK constraint, a target framework, a pin).
 * The first is upgraded through Dev Setup, the second by rewriting the one value in its file.
 */

const ROW = 'relative flex items-center gap-3 rounded-lg bg-foreground/[0.03] px-3 py-2.5';

function OutdatedEdge(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-warning"
    />
  );
}

function ToolchainRow({ toolchain }: { toolchain: string }): React.JSX.Element {
  const navigate = useNavigate();
  const status = useToolchainStatus(toolchain);
  const name = toolchainName(toolchain);
  const latest = status.update?.state === 'update' ? status.update.latest : null;
  const missing = status.detection?.state === 'absent';

  async function upgrade(): Promise<void> {
    try {
      if ((await status.upgrade()) === 'manual') navigate(devSetupLink(toolchain));
    } catch {
      toast.error(`Could not start the ${name} update.`);
    }
  }

  return (
    <div className={ROW}>
      {latest && <OutdatedEdge />}
      <Cpu className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">installed on this machine</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
          {status.detection === undefined
            ? 'Checking…'
            : missing
              ? 'Not found'
              : (status.installedVersion ?? 'Version unknown')}
          {latest && (
            <Badge variant="warning" className="px-1.5 py-0 font-sans text-[10px] leading-4">
              {latest} available
            </Badge>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {status.upgrading ? (
          <Spinner className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : latest ? (
          <Button variant="outline" size="sm" onClick={() => void upgrade()}>
            Upgrade {name}
          </Button>
        ) : missing || status.update?.state === 'unknown' ? (
          <SimpleTooltip
            label={
              missing
                ? `Install ${name} from Dev Setup.`
                : `Runova can't tell whether this ${name} has an update, for example when it was installed by its own script. Dev Setup has the install page.`
            }
          >
            <Button variant="ghost" size="sm" onClick={() => navigate(devSetupLink(toolchain))}>
              <ExternalLink className="h-3.5 w-3.5" />
              Dev Setup
            </Button>
          </SimpleTooltip>
        ) : status.update?.state === 'current' ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3 w-3 text-success" /> Current
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Why the Update button is off, or null when it is on. */
function blockedReason(target: RuntimeTarget, installed: string | null): string | null {
  if (!target.nextDeclared) {
    return 'Runova only rewrites the common forms of this value. Use Update with AI for this one.';
  }
  const { requires } = target;
  if (!requires) return null;
  const name = toolchainName(requires.toolchain);
  if (!installed) return `Needs ${name} ${requires.minVersion} or newer, which is not installed.`;
  if (compareVersions(installed, requires.minVersion) < 0) {
    return `Needs ${name} ${requires.minVersion} or newer, and ${installed} is installed. Upgrade ${name} first.`;
  }
  return null;
}

function RuntimeTargetRow({
  target,
  showProject,
  busy,
  onUpdate,
}: {
  target: RuntimeTarget;
  showProject: boolean;
  busy: boolean;
  onUpdate: () => void;
}): React.JSX.Element {
  const toolchain = useToolchainStatus(target.requires?.toolchain ?? null);
  const bump =
    target.isOutdated && target.latestVersion
      ? bumpKind(target.currentVersion, target.latestVersion)
      : null;
  const blocked = target.isOutdated ? blockedReason(target, toolchain.installedVersion) : null;
  const checking = target.requires !== null && toolchain.detection === undefined;

  return (
    <div className={ROW}>
      {target.isOutdated && <OutdatedEdge />}
      <span className="w-[18px] shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">{runtimeLabel(target)}</span>
          {showProject && (
            <SimpleTooltip label={target.manifestPath}>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
                {target.projectLabel}
              </Badge>
            </SimpleTooltip>
          )}
          {!target.latestVersion && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
              Latest unknown
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums">
            <span className="text-muted-foreground">{target.declared}</span>
            {target.isOutdated && (
              <>
                <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />
                <span className="text-foreground">
                  {target.nextDeclared ?? target.latestVersion}
                </span>
              </>
            )}
          </span>
          {bump && (
            <Badge
              variant={bump === 'major' ? 'warning' : 'outline'}
              className="px-1.5 py-0 text-[10px] leading-4"
            >
              {bump === 'major' ? 'Major' : bump === 'minor' ? 'Minor' : 'Patch'}
            </Badge>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {busy ? (
          <Spinner className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : target.isOutdated ? (
          <SimpleTooltip
            label={blocked ?? `Writes ${target.nextDeclared} to the file.`}
            wrapTrigger
          >
            <Button
              variant="outline"
              size="sm"
              disabled={blocked !== null || checking}
              aria-label={`Update ${runtimeLabel(target)}`}
              onClick={onUpdate}
            >
              Update
            </Button>
          </SimpleTooltip>
        ) : target.latestVersion ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3 w-3 text-success" /> Current
          </span>
        ) : null}
      </div>
    </div>
  );
}

function runtimeKey(target: RuntimeTarget): string {
  return `${target.manifestPath}::${target.source}::${target.kind}`;
}

export function RuntimeBlock({
  projectId,
  section,
  onlyOutdated,
}: {
  projectId: string;
  section: PackageManagerSection;
  /** The Outdated filter: show only targets with a newer version, and leave the toolchain out. */
  onlyOutdated: boolean;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (target: RuntimeTarget) =>
      window.runova.packages.updateRuntime(projectId, {
        ecosystem: section.ecosystem,
        source: target.source,
        kind: target.kind,
        manifestPath: target.manifestPath,
        targetVersion: target.latestVersion ?? '',
      }),
    onSuccess: (result) => {
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      void queryClient.invalidateQueries({ queryKey: queryKeys.packages(projectId) });
    },
    onError: () => toast.error('The runtime update did not run.'),
    meta: { silentLoading: true },
  });

  const targets = onlyOutdated ? section.runtimes.filter((t) => t.isOutdated) : section.runtimes;
  const showToolchain = !onlyOutdated && section.toolchain !== null;
  if (targets.length === 0 && !showToolchain) return null;
  const showProject = new Set(section.runtimes.map((t) => t.projectLabel)).size > 1;
  const busyKey = mutation.isPending && mutation.variables ? runtimeKey(mutation.variables) : null;

  return (
    <div className="space-y-1.5">
      <p className="px-1 text-xs font-medium text-muted-foreground">Runtime</p>
      {showToolchain && section.toolchain && <ToolchainRow toolchain={section.toolchain} />}
      {targets.map((target) => (
        <RuntimeTargetRow
          key={runtimeKey(target)}
          target={target}
          showProject={showProject}
          busy={busyKey === runtimeKey(target)}
          onUpdate={() => mutation.mutate(target)}
        />
      ))}
    </div>
  );
}
