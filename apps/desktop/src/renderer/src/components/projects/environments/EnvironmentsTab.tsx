import {
  ENVIRONMENT_KIND_LABELS,
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  type Project,
} from '@runova/core';
import type { EnvCredentialSummary, EnvFileSummary, ProjectEnvironment } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronDown,
  Copy,
  Download,
  FileText,
  Key,
  Link,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from '@/components/icons';
import { SectionEmptyState } from '@/components/projects/ProjectDetailChrome';
import { ServersVaultControls } from '@/components/remote/ServersVaultControls';
import { SshVaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { EnvCredentialDialog } from './EnvCredentialDialog';
import { EnvFileDialog } from './EnvFileDialog';
import { EnvironmentFormDialog } from './EnvironmentFormDialog';
import { EnvironmentKindBadge, EnvironmentKindDot } from './EnvironmentKindBadge';
import { ImportEnvFilesDialog } from './ImportEnvFilesDialog';
import { ipcErrorMessage } from './ipcError';

function updatedLabel(updatedAt: number): string {
  return `updated ${timeAgo(new Date(updatedAt).toISOString())}`;
}

function AddEnvironmentMenu({
  onPick,
  size = 'sm',
}: {
  onPick: (kind: EnvironmentKind) => void;
  size?: 'sm' | 'default';
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size}>
          <Plus className="h-3.5 w-3.5" /> Add environment <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ENVIRONMENT_KINDS.filter((kind) => kind !== 'custom').map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => onPick(kind)}>
            <EnvironmentKindDot kind={kind} /> {ENVIRONMENT_KIND_LABELS[kind]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onPick('custom')}>Custom...</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <Button size="icon" variant="ghost" onClick={onClick} disabled={disabled} aria-label={label}>
        {children}
      </Button>
    </SimpleTooltip>
  );
}

export function EnvironmentsTab({ project }: { project: Project }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [environmentDialog, setEnvironmentDialog] = useState<{
    open: boolean;
    initial?: ProjectEnvironment;
    kind?: EnvironmentKind;
  }>({ open: false });
  const [fileDialog, setFileDialog] = useState<{ open: boolean; file?: EnvFileSummary }>({
    open: false,
  });
  const [credentialDialog, setCredentialDialog] = useState<{
    open: boolean;
    credential?: EnvCredentialSummary;
  }>({ open: false });
  const [importOpen, setImportOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockMode, setUnlockMode] = useState<'unlock' | 'set'>('unlock');
  const [afterUnlock, setAfterUnlock] = useState<(() => void) | null>(null);

  const environmentsQuery = useQuery({
    queryKey: queryKeys.projectEnvironments(project.id),
    queryFn: () => window.runova.environments.list(project.id),
  });
  const environments = environmentsQuery.data ?? [];
  const selected = environments.find((e) => e.id === selectedId) ?? environments[0];

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectEnvironments(project.id) });
  }

  /** Runs `action` now, or after the user unlocks the vault when a passkey is set and locked. */
  async function withVault(action: () => void): Promise<void> {
    const status = await window.runova.ssh.vaultStatus();
    if (status.hasPasskey && !status.unlocked) {
      setAfterUnlock(() => action);
      setUnlockMode('unlock');
      setUnlockOpen(true);
      return;
    }
    action();
  }

  function handleUnlocked(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sshVaultStatus });
    afterUnlock?.();
    setAfterUnlock(null);
  }

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      toast.error(ipcErrorMessage(error, fallback));
    }
  }

  async function removeEnvironment(environment: ProjectEnvironment): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete "${environment.name}"?`,
      description: `Its ${environment.files.length} env file(s) and ${environment.credentials.length} credential(s) are deleted from Runova. Files in the project folder are not touched.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!confirmed) return;
    await run(async () => {
      await window.runova.environments.remove(environment.id);
      setSelectedId(null);
      refresh();
    }, 'Could not delete the environment.');
  }

  async function removeFile(environment: ProjectEnvironment, file: EnvFileSummary): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete ${file.fileName} from ${environment.name}?`,
      description: 'The copy saved in Runova is deleted. The project folder is not touched.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!confirmed) return;
    await run(async () => {
      await window.runova.environments.removeFile(environment.id, file.id);
      refresh();
    }, 'Could not delete the file.');
  }

  async function removeCredential(
    environment: ProjectEnvironment,
    credential: EnvCredentialSummary,
  ): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete "${credential.label}"?`,
      description: 'The saved username, password and notes are deleted.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!confirmed) return;
    await run(async () => {
      await window.runova.environments.removeCredential(environment.id, credential.id);
      refresh();
    }, 'Could not delete the credential.');
  }

  function copyFile(environment: ProjectEnvironment, file: EnvFileSummary): void {
    void withVault(() =>
      run(async () => {
        await window.runova.environments.copyFile(environment.id, file.id);
        toast.success(`${file.fileName} copied to the clipboard.`);
      }, 'Could not copy that file.'),
    );
  }

  function copySecret(environment: ProjectEnvironment, credential: EnvCredentialSummary): void {
    void withVault(() =>
      run(async () => {
        await window.runova.environments.copyCredentialSecret(environment.id, credential.id);
        toast.success('Password copied to the clipboard.');
      }, 'Could not copy the password.'),
    );
  }

  function writeToFolder(environment: ProjectEnvironment, file: EnvFileSummary): void {
    void withVault(() =>
      run(async () => {
        let result = await window.runova.environments.writeToFolder(environment.id, file.id, false);
        if (result.status === 'exists') {
          const confirmed = await confirmDialog({
            title: `Replace ${file.fileName} in the project folder?`,
            description: `A ${file.fileName} already exists at ${result.path}. It will be overwritten with the copy saved for ${environment.name}.`,
            confirmLabel: 'Replace',
            variant: 'destructive',
          });
          if (!confirmed) return;
          result = await window.runova.environments.writeToFolder(environment.id, file.id, true);
        }
        toast.success(`Wrote ${file.fileName} to the project folder.`);
        if (result.notIgnored) {
          toast.warning(
            `${file.fileName} is not in .gitignore, so it could be committed. Add it before your next commit.`,
          );
        }
      }, 'Could not write that file.'),
    );
  }

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <ServersVaultControls
        onRequestDialog={(mode) => {
          setUnlockMode(mode);
          setUnlockOpen(true);
        }}
      />
      <Button size="sm" variant="outline" onClick={() => void withVault(() => setImportOpen(true))}>
        <Download className="h-3.5 w-3.5" /> Import from folder
      </Button>
      <AddEnvironmentMenu
        onPick={(kind) => void withVault(() => setEnvironmentDialog({ open: true, kind }))}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-xl text-sm text-muted-foreground">
          Keep this project's env files and logins for each stage in one place. Everything is stored
          encrypted on this computer, and can go into a password protected backup.
        </p>
        {environments.length > 0 && toolbar}
      </div>

      {environmentsQuery.isLoading && (
        <div className="flex flex-col gap-4 lg:flex-row">
          <Skeleton className="h-40 w-full lg:w-56" />
          <div className="flex flex-1 flex-col gap-4">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        </div>
      )}

      {environmentsQuery.isError && (
        <p className="text-sm text-destructive">
          {ipcErrorMessage(environmentsQuery.error, 'Could not load environments.')}
        </p>
      )}

      {environmentsQuery.isSuccess && environments.length === 0 && (
        <SectionEmptyState
          icon={Key}
          title="No environments yet"
          description="Add production, staging or test, then save their .env files and credentials. Or pull in the .env files already in the project folder."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void withVault(() => setImportOpen(true))}
              >
                <Download className="h-3.5 w-3.5" /> Import from folder
              </Button>
              <AddEnvironmentMenu
                onPick={(kind) => void withVault(() => setEnvironmentDialog({ open: true, kind }))}
              />
            </div>
          }
        />
      )}

      {selected && (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <nav className="flex gap-1 overflow-x-auto lg:w-56 lg:shrink-0 lg:flex-col">
            {environments.map((environment) => (
              <button
                key={environment.id}
                type="button"
                onClick={() => setSelectedId(environment.id)}
                className={cn(
                  'flex min-w-40 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                  environment.id === selected.id
                    ? 'bg-primary/15 text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <EnvironmentKindDot kind={environment.kind} />
                <span className="min-w-0 flex-1 truncate font-medium">{environment.name}</span>
                <span className="text-xs text-muted-foreground">
                  {environment.files.length + environment.credentials.length}
                </span>
              </button>
            ))}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">{selected.name}</h3>
              <EnvironmentKindBadge kind={selected.kind} />
              <div className="ml-auto flex items-center">
                <IconAction
                  label="Rename or change the kind"
                  onClick={() => setEnvironmentDialog({ open: true, initial: selected })}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </IconAction>
                <IconAction
                  label="Delete this environment"
                  onClick={() => void removeEnvironment(selected)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconAction>
              </div>
            </div>

            <Card className="glass">
              <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-primary" /> Env files
                  </CardTitle>
                  <CardDescription>Saved copies you can write back to the folder.</CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void withVault(() => setFileDialog({ open: true }))}
                >
                  <Plus className="h-3.5 w-3.5" /> Add file
                </Button>
              </CardHeader>
              <CardContent>
                {selected.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No env files saved yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {selected.files.map((file) => (
                      <li
                        key={file.id}
                        className="flex items-center gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2"
                      >
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-sm">{file.fileName}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {file.keyCount} {file.keyCount === 1 ? 'key' : 'keys'} ·{' '}
                            {updatedLabel(file.updatedAt)}
                          </p>
                        </div>
                        <IconAction
                          label="Edit"
                          onClick={() => void withVault(() => setFileDialog({ open: true, file }))}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </IconAction>
                        <IconAction label="Copy contents" onClick={() => copyFile(selected, file)}>
                          <Copy className="h-3.5 w-3.5" />
                        </IconAction>
                        <IconAction
                          label={`Write ${file.fileName} to the project folder`}
                          onClick={() => writeToFolder(selected, file)}
                        >
                          <Upload className="h-3.5 w-3.5" />
                        </IconAction>
                        <IconAction label="Delete" onClick={() => void removeFile(selected, file)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconAction>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Key className="h-4 w-4 text-primary" /> Credentials
                  </CardTitle>
                  <CardDescription>
                    Databases, dashboards, servers and other logins for this stage.
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void withVault(() => setCredentialDialog({ open: true }))}
                >
                  <Plus className="h-3.5 w-3.5" /> Add credential
                </Button>
              </CardHeader>
              <CardContent>
                {selected.credentials.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No credentials saved yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {selected.credentials.map((credential) => (
                      <li
                        key={credential.id}
                        className="flex items-center gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2"
                      >
                        <Key className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{credential.label}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {[credential.username, credential.url].filter(Boolean).join(' · ') ||
                              updatedLabel(credential.updatedAt)}
                          </p>
                        </div>
                        {credential.url && /^https?:\/\//i.test(credential.url) && (
                          <IconAction
                            label="Open the URL"
                            onClick={() => void window.runova.shell.openExternal(credential.url)}
                          >
                            <Link className="h-3.5 w-3.5" />
                          </IconAction>
                        )}
                        <IconAction
                          label={credential.hasSecret ? 'Copy password' : 'No password saved'}
                          disabled={!credential.hasSecret}
                          onClick={() => copySecret(selected, credential)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </IconAction>
                        <IconAction
                          label="Edit"
                          onClick={() =>
                            void withVault(() => setCredentialDialog({ open: true, credential }))
                          }
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </IconAction>
                        <IconAction
                          label="Delete"
                          onClick={() => void removeCredential(selected, credential)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconAction>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <EnvironmentFormDialog
        open={environmentDialog.open}
        onOpenChange={(open) => setEnvironmentDialog((current) => ({ ...current, open }))}
        projectId={project.id}
        initial={environmentDialog.initial}
        initialKind={environmentDialog.kind}
        onSaved={(environment) => {
          setSelectedId(environment.id);
          refresh();
        }}
      />
      {selected && (
        <>
          <EnvFileDialog
            open={fileDialog.open}
            onOpenChange={(open) => setFileDialog((current) => ({ ...current, open }))}
            environment={selected}
            file={fileDialog.file}
            onSaved={refresh}
          />
          <EnvCredentialDialog
            open={credentialDialog.open}
            onOpenChange={(open) => setCredentialDialog((current) => ({ ...current, open }))}
            environment={selected}
            initial={credentialDialog.credential}
            onSaved={refresh}
          />
        </>
      )}
      <ImportEnvFilesDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={project.id}
        environments={environments}
        onImported={refresh}
      />
      <SshVaultUnlockDialog
        open={unlockOpen}
        onOpenChange={(open) => {
          setUnlockOpen(open);
          if (!open) setAfterUnlock(null);
        }}
        mode={unlockMode}
        onUnlocked={handleUnlocked}
      />
    </div>
  );
}
