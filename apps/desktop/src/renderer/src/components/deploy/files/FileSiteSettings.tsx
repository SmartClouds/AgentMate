import type { Project } from '@agentmat/core';
import type { FileSite } from '@shared/deployFilesTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Filter,
  FolderKanban,
  Key,
  Pencil,
  Save,
  Spinner,
  Trash2,
  Undo,
  Wand2,
} from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { DeployCard, FactRow, FactRows } from '../deployKit';
import { siteInputFrom } from './deployPlan';
import { QUIET, useFileSiteListUpdate, useSavedServerNames } from './hooks';
import { DEFAULT_PORT, filesProblem, PROTOCOL_DESCRIPTION, PROTOCOL_LABEL } from './messages';

/**
 * An FTP or SFTP site's Settings (E23): the connection at a glance with the way to edit it,
 * Deploy on save, the site's own ignore lines checked as they are typed, the projects it is
 * attached to, and the two ways to start over: forget what was deployed, or remove the site.
 */

/** How long typing pauses before the ignore lines are checked. */
const CHECK_DELAY_MS = 300;

type IgnoreCheck = { ok: true } | { ok: false; line: number; reason: string };

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function cleanLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

export function FileSiteSettings({
  site,
  onEdit,
  onRemoved,
}: {
  site: FileSite;
  onEdit: () => void;
  onRemoved: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <ConnectionCard site={site} onEdit={onEdit} />
      <DeployOnSaveCard site={site} />
      <IgnoreCard site={site} />
      <ProjectsCard site={site} />
      <StartOverCard site={site} onRemoved={onRemoved} />
    </div>
  );
}

function ConnectionCard({ site, onEdit }: { site: FileSite; onEdit: () => void }) {
  const names = useSavedServerNames();
  const { connection, capabilities } = site;
  let server: string;
  let login: string;
  if (connection.kind === 'saved') {
    const name = names.get(connection.sshServerId);
    server = 'Through a saved server in Remote';
    login = name ? `The login saved for ${name}` : 'The login saved in Remote';
  } else {
    const port = connection.port === DEFAULT_PORT[site.protocol] ? '' : `:${connection.port}`;
    server = `${connection.username}@${connection.host}${port}`;
    login =
      connection.authMethod === 'privateKey'
        ? `Key file ${connection.privateKeyPath ?? ''}`.trim()
        : connection.hasSecret
          ? 'Password, saved'
          : 'Password, not saved';
  }
  const detection = !capabilities
    ? 'Not tested yet. Run Test connection from Edit to find out.'
    : capabilities.mtime === 'exact'
      ? 'Exact, from file times on the server'
      : capabilities.mtime === 'mdtm'
        ? 'From file times, asked file by file'
        : 'By size only, since this server gives no usable file times';

  return (
    <DeployCard
      aria-label="Connection"
      icon={<Key />}
      title="Connection"
      description={PROTOCOL_DESCRIPTION[site.protocol]}
      actions={
        <Button size="sm" variant="soft" onClick={onEdit}>
          <Pencil /> Edit
        </Button>
      }
    >
      <FactRows>
        <FactRow label="Protocol">{PROTOCOL_LABEL[site.protocol]}</FactRow>
        <FactRow label="Server">
          <span className={cn(connection.kind === 'custom' && 'font-mono text-xs')}>{server}</span>
        </FactRow>
        <FactRow label="Login">{login}</FactRow>
        <FactRow label="Deploy folder">
          <span className="break-all font-mono text-xs">{site.localFolder}</span>
        </FactRow>
        <FactRow label="Folder on the server">
          <span className="break-all font-mono text-xs">{site.remoteRoot}</span>
        </FactRow>
        <FactRow label="Changes on the server">
          {detection}
          {capabilities && !capabilities.atomicReplace && (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              This server can't replace a file in one step, so for a moment during each upload the
              old file is gone.
            </span>
          )}
        </FactRow>
      </FactRows>
    </DeployCard>
  );
}

function DeployOnSaveCard({ site }: { site: FileSite }) {
  const id = useId();
  const update = useFileSiteListUpdate();
  const [saving, setSaving] = useState(false);

  async function toggle(enabled: boolean): Promise<void> {
    setSaving(true);
    try {
      const saved = await window.agentmat.deployFiles.setDeployOnSave(site.id, enabled);
      if (saved) update(saved);
    } catch (error) {
      toast.error(filesProblem(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DeployCard
      icon={<Wand2 />}
      title="Deploy on save"
      description="Sends your changes on its own. It never resolves a conflict or deletes many files on its own; those wait for you."
    >
      <div className="flex items-start gap-3">
        <Switch
          id={id}
          aria-label="Deploy on save"
          checked={site.deployOnSave}
          disabled={saving}
          onCheckedChange={(checked) => void toggle(checked)}
          className="mt-0.5"
        />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer space-y-0.5">
          <span className="block text-sm font-medium">{site.deployOnSave ? 'On' : 'Off'}</span>
          <span className="block text-xs text-muted-foreground">
            Starts {site.quietSeconds} seconds after the last change in the deploy folder. Change
            the wait in Edit.
          </span>
        </label>
      </div>
    </DeployCard>
  );
}

function IgnoreCard({ site }: { site: FileSite }) {
  const id = useId();
  const update = useFileSiteListUpdate();
  const [text, setText] = useState(site.ignorePatterns.join('\n'));
  const [check, setCheck] = useState<IgnoreCheck | null>({ ok: true });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lines = splitLines(text);
  const cleaned = cleanLines(lines);
  const changed = !sameLines(cleaned, site.ignorePatterns);

  useEffect(() => {
    setCheck(null);
    const timer = window.setTimeout(() => {
      Promise.resolve(window.agentmat.deployFiles.validateIgnore(splitLines(text)))
        .then((result) => setCheck(result ?? { ok: true }))
        .catch(() => setCheck({ ok: true }));
    }, CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  async function save(): Promise<void> {
    setSaving(true);
    setProblem(null);
    try {
      const saved = await window.agentmat.deployFiles.update(
        site.id,
        siteInputFrom(site, { ignorePatterns: cleaned }),
      );
      if (saved) update(saved);
      toast.success('Saved the ignore lines.');
    } catch (error) {
      setProblem(filesProblem(error));
    } finally {
      setSaving(false);
    }
  }

  const invalid = check?.ok === false ? check : null;

  return (
    <DeployCard
      icon={<Filter />}
      tone="neutral"
      title="Ignore lines"
      description={
        <>
          Files to leave out of this site, one pattern a line, as in a .gitignore. Start a line with
          ! to bring a file back. The folder's own .agentmateignore applies too, and secrets and
          agent files are never sent whatever these say.
        </>
      }
    >
      <div className="space-y-2">
        <Textarea
          id={id}
          aria-label="Ignore lines"
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={5}
          placeholder={'*.map\nnode_modules/\n!keep-this.map'}
          className="font-mono text-xs"
        />
        {invalid && (
          <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
            Line {invalid.line}: {invalid.reason}
          </p>
        )}
        {problem && (
          <Notice role="alert" tone="destructive" size="sm">
            {problem}
          </Notice>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            aria-label="Save the ignore lines"
            disabled={!changed || saving || check?.ok !== true}
            onClick={() => void save()}
          >
            {saving ? <Spinner className="motion-safe:animate-spin" /> : <Save />}
            Save
          </Button>
        </div>
      </div>
    </DeployCard>
  );
}

function ProjectsCard({ site }: { site: FileSite }) {
  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: async (): Promise<Project[]> => (await window.agentmat.projects.list()) ?? [],
    meta: QUIET,
  });
  const byId = new Map((projects.data ?? []).map((project) => [project.id, project]));

  return (
    <DeployCard
      icon={<FolderKanban />}
      tone="neutral"
      title="Projects"
      description="Each project this site is attached to shows it on its Deploy tab."
    >
      {site.projectIds.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Not attached to a project. Edit the site to attach one.
        </p>
      ) : (
        <ul aria-label="Attached projects" className="settings-rows">
          {site.projectIds.map((projectId) => {
            const project = byId.get(projectId);
            return (
              <li key={projectId} className="py-2 text-sm">
                {project ? (
                  <Link
                    to={`/projects/${projectId}?tab=deploy`}
                    className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {project.name}
                  </Link>
                ) : projects.isPending ? (
                  <span className="text-muted-foreground">Loading…</span>
                ) : (
                  <span className="text-muted-foreground">A project that no longer exists</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DeployCard>
  );
}

function StartOverCard({ site, onRemoved }: { site: FileSite; onRemoved: () => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'forget' | 'remove' | null>(null);

  async function forget(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Forget what was deployed to this site?',
      description:
        "AgentMate forgets which files earlier deploys sent. The next deploy is treated as a first one: it compares the server folder by size and asks how to handle what's there. Nothing on the server changes now.",
      confirmLabel: 'Forget',
    });
    if (!confirmed) return;
    setBusy('forget');
    try {
      await window.agentmat.deployFiles.forgetBase(site.id);
      toast.success('Forgot what was deployed. The next deploy starts fresh.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployFilesChanges(site.id) });
    } catch (error) {
      toast.error(filesProblem(error));
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove ${site.label}?`,
      description:
        site.connection.kind === 'saved'
          ? 'The site goes from AgentMate with its deploy history. The server stays saved in Remote. Files on the server are not touched, and neither is the deploy folder.'
          : 'The site goes from AgentMate, with its login and its deploy history. Files on the server are not touched, and neither is the deploy folder.',
      confirmLabel: 'Remove site',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setBusy('remove');
    try {
      await window.agentmat.deployFiles.remove(site.id);
      queryClient.setQueryData<FileSite[]>(queryKeys.deployFilesSites, (sites) =>
        sites?.filter((one) => one.id !== site.id),
      );
      useDeployFilesRunStore.getState().forget(site.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployFilesSites, exact: true });
      toast.success(`Removed ${site.label}.`);
      onRemoved();
    } catch (error) {
      toast.error(filesProblem(error));
      setBusy(null);
    }
  }

  return (
    <DeployCard
      icon={<Undo />}
      tone="destructive"
      title="Start over"
      description="Neither of these changes anything on the server."
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
        <div className="min-w-0 flex-1 space-y-1">
          <Button size="sm" variant="soft" disabled={busy !== null} onClick={() => void forget()}>
            {busy === 'forget' ? <Spinner className="motion-safe:animate-spin" /> : <Undo />}
            Forget what was deployed
          </Button>
          <p className="text-xs text-muted-foreground">
            For a server folder that was changed or emptied outside AgentMate.
          </p>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void remove()}>
            {busy === 'remove' ? <Spinner className="motion-safe:animate-spin" /> : <Trash2 />}
            Remove site
          </Button>
          <p className="text-xs text-muted-foreground">
            Removes it from AgentMate. The files stay where they are.
          </p>
        </div>
      </div>
    </DeployCard>
  );
}
