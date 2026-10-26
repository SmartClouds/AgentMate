import type { UiProInstallMethod } from '@runova/core';
import {
  buildUiProDesignSystemCommand,
  buildUiProUpdatePlan,
  UI_UX_PRO_MAX_EXAMPLE_PROMPTS,
  UI_UX_PRO_MAX_GITHUB_URL,
  UI_UX_PRO_MAX_HIGHLIGHTS,
  UI_UX_PRO_MAX_HOMEPAGE,
  UI_UX_PRO_MAX_RULE_CATEGORIES,
  UI_UX_PRO_MAX_SKILL_ID,
  UI_UX_PRO_MAX_STACK_GROUPS,
} from '@runova/core';
import type { UiProUpdateCheck } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  CloudDownload,
  Download,
  ExternalLink,
  Eye,
  Globe,
  RefreshCw,
  Sparkles,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useTerminalStore } from '@/stores/terminalStore';
import { UiUxProMaxWizard } from './UiUxProMaxWizard';

const PIPELINE = [
  { title: 'You ask', detail: 'Any UI/UX task: build, design, review, fix, improve.' },
  {
    title: 'Multi-domain search',
    detail: '5 parallel searches over product types, styles, palettes, patterns, and typography.',
  },
  {
    title: 'Reasoning engine',
    detail: 'BM25 ranking, industry rules, and anti-pattern filtering for your sector.',
  },
  {
    title: 'Design system out',
    detail: 'Pattern, style, colors, type, effects, anti-patterns, pre-delivery checklist.',
  },
];

/** Keeps the check off the app's loading overlay: it reports progress on its own button. */
const UPDATE_CHECK_META = { silentLoading: true } as const;

/** The four ways a version check can land, flattened out of the check result for rendering. */
function updateStatus(check: UiProUpdateCheck): {
  kind: 'missing' | 'offline' | 'update' | 'current';
  headline: string;
  detail: string;
} {
  if (!check.cliFound) {
    return {
      kind: 'missing',
      headline: 'The uipro CLI is not on this machine',
      detail: check.latestVersion
        ? `The latest release is ${check.latestVersion}. Install the skill to get it.`
        : 'Install the skill first, then this button reports new releases.',
    };
  }
  if (!check.latestVersion) {
    return {
      kind: 'offline',
      headline: 'Could not reach the npm registry',
      detail: 'The installed CLI was found, the latest release was not. Try again in a moment.',
    };
  }
  if (check.updateAvailable && check.installedVersion) {
    return {
      kind: 'update',
      headline: `Update available: ${check.installedVersion} to ${check.latestVersion}`,
      detail:
        'Updating pulls the new CLI, then re-runs uipro update to regenerate the skill files.',
    };
  }
  // A CLI whose --version printed nothing recognizable cannot be compared, so it is offered the
  // update rather than being called up to date.
  if (!check.installedVersion) {
    return {
      kind: 'update',
      headline: `The latest release is ${check.latestVersion}`,
      detail: 'The installed CLI did not report a version, so run the update to be sure.',
    };
  }
  return {
    kind: 'current',
    headline: `Up to date, uipro ${check.installedVersion}`,
    detail: 'The skill files came from this release. Re-run the update to regenerate them anyway.',
  };
}

/**
 * The featured entry for UI UX Pro Max (https://github.com/nextlevelbuilder/ui-ux-pro-max-skill).
 * It sits apart from the repository and skills.sh tabs because it is installed by its own CLI
 * rather than by copying files, so it gets a dedicated wizard.
 */
export function UiUxProMaxCard(): React.JSX.Element {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const queryClient = useQueryClient();
  const openTerminalSession = useTerminalStore((s) => s.openSession);

  const globalInstalledQuery = useQuery({
    queryKey: queryKeys.installedSkills(null),
    queryFn: () => window.runova.skills.listInstalled(null),
  });
  const globalRecord = globalInstalledQuery.data?.find((s) => s.skillId === UI_UX_PRO_MAX_SKILL_ID);

  // The route the skill was installed by decides how it is updated: npx never installs the CLI
  // globally, and the Claude Code plugin is updated from inside Claude Code instead.
  const installMethod = (globalRecord?.installMethod ?? 'npm-global') as UiProInstallMethod;
  const isPluginInstall = installMethod === 'claude-plugin';

  const updateCheck = useMutation({
    mutationFn: () => window.runova.skills.checkUiProUpdate(),
    // The button carries its own spinner, so this must not raise the full-page overlay.
    meta: UPDATE_CHECK_META,
    onSuccess: () => {
      // The wizard shows the same `uipro --version`, so let it re-probe next time it opens.
      void queryClient.invalidateQueries({ queryKey: queryKeys.uiProPrerequisites });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const check = updateCheck.data;
  const status = check ? updateStatus(check) : null;

  /**
   * Types the update into a terminal tab without running it, the same way the install wizard
   * does, so the commands can be read first. PowerShell 5.1 has no `&&`, hence `;`.
   */
  function runUpdate(): void {
    const plan = buildUiProUpdatePlan({ method: installMethod, global: Boolean(globalRecord) });
    const commands = [...plan.setup, ...plan.install];
    if (commands.length === 0) return;
    openTerminalSession({
      title: 'Update UI UX Pro Max',
      initialInput: commands.join('; '),
    });
    toast.info('Press Enter in the terminal to run the update.');
  }

  return (
    <>
      <Card className="glass overflow-hidden rounded-[calc(var(--radius)+2px)]">
        <div className="h-1 w-full bg-gradient-to-r from-primary via-primary/50 to-transparent" />
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> UI UX Pro Max
            </CardTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone="primary">Featured</Chip>
              <Chip>MIT</Chip>
              {globalRecord && (
                <Chip tone="success" dot>
                  Installed globally
                </Chip>
              )}
            </div>
          </div>
          <CardDescription>
            Design intelligence for building professional UI/UX across platforms and frameworks. It
            activates on its own when you ask an assistant for UI work, and answers with a complete
            design system: pattern, style, palette, typography, effects, and the anti-patterns to
            avoid for that industry.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {UI_UX_PRO_MAX_HIGHLIGHTS.map((highlight) => (
              <SimpleTooltip key={highlight.label} label={highlight.detail}>
                <div className="rounded-lg bg-foreground/[0.04] px-3 py-2">
                  <p className="text-lg font-semibold text-foreground">{highlight.count}</p>
                  <p className="text-xs text-muted-foreground">{highlight.label}</p>
                </div>
              </SimpleTooltip>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="lg" onClick={() => setWizardOpen(true)}>
              <Download className="h-4 w-4" /> {globalRecord ? 'Install again' : 'Install'}
            </Button>
            <Button variant="soft" size="lg" onClick={() => setDetailsOpen(true)}>
              <Eye className="h-4 w-4" /> What it does
            </Button>
            <Button
              variant="soft"
              size="lg"
              disabled={updateCheck.isPending}
              onClick={() => updateCheck.mutate()}
            >
              {updateCheck.isPending ? (
                <Spinner className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {updateCheck.isPending ? 'Checking…' : 'Check for updates'}
            </Button>
            <SimpleTooltip label="Open the repository on GitHub">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                aria-label="Open the repository on GitHub"
                onClick={() => void window.runova.shell.openExternal(UI_UX_PRO_MAX_GITHUB_URL)}
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Open uupm.cc">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                aria-label="Open uupm.cc"
                onClick={() => void window.runova.shell.openExternal(UI_UX_PRO_MAX_HOMEPAGE)}
              >
                <Globe className="h-4 w-4" />
              </Button>
            </SimpleTooltip>
          </div>

          {status && (
            <div
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-lg px-3 py-2.5 ring-1 ring-inset',
                status.kind === 'update'
                  ? 'bg-primary/10 ring-primary/40'
                  : 'bg-foreground/[0.04] ring-transparent',
              )}
            >
              {status.kind === 'update' ? (
                <CloudDownload className="h-4 w-4 shrink-0 text-primary" />
              ) : status.kind === 'current' ? (
                <CircleCheck className="h-4 w-4 shrink-0 text-success" />
              ) : (
                <TriangleAlert className="h-4 w-4 shrink-0 text-warning" />
              )}

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{status.headline}</p>
                <p className="text-xs text-muted-foreground">
                  {isPluginInstall && status.kind !== 'missing'
                    ? 'Installed through the Claude Code plugin marketplace, so update it from /plugin inside Claude Code.'
                    : status.detail}
                </p>
              </div>

              {status.kind === 'missing' ? (
                <Button onClick={() => setWizardOpen(true)}>
                  <Download className="h-4 w-4" /> Install
                </Button>
              ) : (
                !isPluginInstall &&
                status.kind !== 'offline' && (
                  <Button
                    variant={status.kind === 'update' ? 'default' : 'soft'}
                    onClick={runUpdate}
                  >
                    <CloudDownload className="h-4 w-4" />
                    {status.kind === 'update' ? 'Update now' : 'Re-run update'}
                  </Button>
                )
              )}
            </div>
          )}

          {globalRecord && globalRecord.agents && globalRecord.agents.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Installed globally for {globalRecord.agents.join(', ')}. Manage it under Global
              Skills.
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> UI UX Pro Max
            </DialogTitle>
            <DialogDescription>
              An AI skill that turns a product description into a tailored design system, then holds
              the assistant to it while it writes the code.
            </DialogDescription>
          </DialogHeader>

          <div className="-mx-1 min-h-0 flex-1 space-y-5 overflow-y-auto px-1 py-1">
            <section className="space-y-2">
              <h3 className="text-sm font-medium">How a request flows</h3>
              <ol className="space-y-1.5">
                {PIPELINE.map((entry, index) => (
                  <li key={entry.title} className="flex gap-2.5 text-sm">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
                      {index + 1}
                    </span>
                    <span>
                      <span className="font-medium text-foreground">{entry.title}.</span>{' '}
                      <span className="text-muted-foreground">{entry.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">161 reasoning rules, by sector</h3>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {UI_UX_PRO_MAX_RULE_CATEGORIES.map((entry) => (
                  <div key={entry.category} className="rounded-lg bg-foreground/[0.04] px-3 py-2">
                    <p className="text-sm font-medium text-foreground">{entry.category}</p>
                    <p className="text-xs text-muted-foreground">{entry.examples}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Each rule carries a recommended page pattern, style priority, color and typography
                mood, key effects, and the anti-patterns for that industry (for example, no AI
                purple gradients on a banking product).
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Stack-specific guidelines</h3>
              <div className="space-y-1">
                {UI_UX_PRO_MAX_STACK_GROUPS.map((entry) => (
                  <p key={entry.group} className="text-sm">
                    <span className="font-medium text-foreground">{entry.group}:</span>{' '}
                    <span className="text-muted-foreground">{entry.stacks}</span>
                  </p>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Mention your stack in the prompt, or let it fall back to HTML + Tailwind.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Prompts that trigger it</h3>
              <div className="space-y-1">
                {UI_UX_PRO_MAX_EXAMPLE_PROMPTS.map((prompt) => (
                  <p
                    key={prompt}
                    className="rounded-md bg-foreground/[0.04] px-2.5 py-1.5 text-xs text-foreground"
                  >
                    {prompt}
                  </p>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Driving the generator directly</h3>
              <p className="break-all rounded-md bg-foreground/[0.04] px-2.5 py-1.5 font-mono text-xs">
                {buildUiProDesignSystemCommand(
                  '.claude/skills',
                  'beauty spa wellness',
                  'Serenity Spa',
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                Add --persist to write design-system/MASTER.md, and --page &lt;name&gt; for a
                page-level override file. The scripts need Python 3.x, standard library only, and
                make no network calls. The wizard checks for Python before you install.
              </p>
            </section>
          </div>

          <DialogFooter>
            <Button
              onClick={() => {
                setDetailsOpen(false);
                setWizardOpen(true);
              }}
            >
              <Download className="h-4 w-4" /> Install…
            </Button>
            <Button
              variant="soft"
              onClick={() => void window.runova.shell.openExternal(UI_UX_PRO_MAX_GITHUB_URL)}
            >
              <ExternalLink className="h-4 w-4" /> Open on GitHub
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UiUxProMaxWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </>
  );
}
