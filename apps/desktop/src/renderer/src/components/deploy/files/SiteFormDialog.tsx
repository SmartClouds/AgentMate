import type { Project } from '@runova/core';
import type { SshSavedServer } from '@shared/apiTypes';
import { filesError } from '@shared/deployFilesErrors';
import type { FileSite, FileSiteProtocol, FilesTestResult } from '@shared/deployFilesTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  FolderOpen,
  FolderTree,
  Pencil,
  Server,
  Spinner,
  TriangleAlert,
  Upload,
} from '@/components/icons';
import { FOOTER_HAIRLINE, Notice, PillTabs, Problem } from '@/components/pageKit';
import { ProjectMultiPicker } from '@/components/projects/ProjectMultiPicker';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { withHostKeyTrust } from '@/lib/ssh/hostKeyTrust';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { filesProblem, PROTOCOL_DESCRIPTION, PROTOCOL_LABEL } from './messages';
import { RemoteFolderBrowser } from './RemoteFolderBrowser';
import {
  browseTarget,
  connectionKey,
  defaultLabel,
  draftFromSite,
  draftToInput,
  emptyDraft,
  firstError,
  keepsStoredSecret,
  MAX_QUIET_SECONDS,
  MIN_QUIET_SECONDS,
  type SiteDraft,
  type SiteDraftErrors,
  type SiteDraftField,
  testBlockers,
  validateDraft,
  withAuthMethod,
  withHost,
  withPort,
  withProtocol,
  withTrust,
} from './siteFormDraft';
import { described, Field, Section } from './siteFormParts';
import { TestConnectionChecklist } from './TestConnectionChecklist';

/**
 * Adds an FTP or SFTP site to Deploy, or edits one (E23). The form runs top to bottom the way a
 * person sets a site up: the server, the two folders, a connection test that proves the login
 * and finds out what the server can do, then the projects and options.
 *
 * Save waits for a passing test (or an explicit "Save without testing"), since a site that can't
 * connect is only a broken row in the rail. Editing only the name, projects or options needs no
 * new test. Enter does the next useful thing: show what's missing, test, or save.
 *
 * A typed password or passphrase lives only in this component's state and goes into the `test`,
 * `browseRemote`, `create` and `update` calls. None of them go through React Query (a mutation
 * keeps its input in the cache), and the secret is dropped whenever the dialog closes.
 */

export interface SiteFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The site to edit; null to add one. */
  site: FileSite | null;
  /** Prefill for a new site opened from a project: attached, with its folder as the deploy folder. */
  initialProjectId?: string | null;
  onSaved: (site: FileSite) => void;
}

const QUIET = { silentLoading: true } as const;

const PROTOCOLS: { value: FileSiteProtocol; label: string }[] = (
  ['sftp', 'ftps', 'ftp'] as const
).map((value) => ({ value, label: PROTOCOL_LABEL[value] }));

interface TestState {
  result: FilesTestResult;
  /** `connectionKey` of what was tested, so a later edit shows the result is out of date. */
  key: string;
}

function blankDraft(initialProjectId: string | null | undefined): SiteDraft {
  return { ...emptyDraft(), projectIds: initialProjectId ? [initialProjectId] : [] };
}

export function SiteFormDialog({
  open,
  onOpenChange,
  site,
  initialProjectId,
  onSaved,
}: SiteFormDialogProps): React.JSX.Element {
  const ids = useId();
  const id = (name: SiteDraftField | string) => `${ids}-${name}`;
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<SiteDraft>(() =>
    site ? draftFromSite(site) : blankDraft(initialProjectId),
  );
  const [initialKey, setInitialKey] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [test, setTest] = useState<TestState | null>(null);
  const [testing, setTesting] = useState(false);
  const [testFailure, setTestFailure] = useState<string | null>(null);
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [ftpConfirmed, setFtpConfirmed] = useState(false);
  const prefilledFolder = useRef(false);

  // Every opening starts from the site (or a blank form), never from the last visit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens
  useEffect(() => {
    if (!open) {
      // Drop the typed secret and what was tested with it, even if the parent keeps this mounted.
      setDraft((current) => ({ ...current, secret: '' }));
      setTest(null);
      return;
    }
    const start = site ? draftFromSite(site) : blankDraft(initialProjectId);
    setDraft(start);
    setInitialKey(site ? connectionKey(start) : null);
    setShowErrors(false);
    setTest(null);
    setTesting(false);
    setTestFailure(null);
    setResolvedRoot(null);
    setBrowsing(false);
    setSaving(false);
    setProblem(null);
    setFtpConfirmed(false);
    prefilledFolder.current = false;
  }, [open, site?.id]);

  const servers = useQuery({
    queryKey: queryKeys.sshServers,
    queryFn: async (): Promise<SshSavedServer[]> => (await window.runova.ssh.listServers()) ?? [],
    enabled: open,
    meta: QUIET,
  });
  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: async (): Promise<Project[]> => (await window.runova.projects.list()) ?? [],
    enabled: open,
    meta: QUIET,
  });

  const projectList = projects.data ?? [];
  const sourceProject = initialProjectId
    ? (projectList.find((one) => one.id === initialProjectId) ?? null)
    : null;

  // A site opened from a project deploys that project's folder unless the user picks another.
  useEffect(() => {
    if (!open || site || !sourceProject || prefilledFolder.current) return;
    prefilledFolder.current = true;
    setDraft((current) =>
      current.localFolder ? current : { ...current, localFolder: sourceProject.folderPath },
    );
  }, [open, site, sourceProject]);

  const serverList = servers.data ?? [];
  const savedServer = serverList.find((one) => one.id === draft.sshServerId) ?? null;
  const sftp = draft.protocol === 'sftp';
  const usesSaved = sftp && draft.source === 'saved';
  const authMethod = sftp ? draft.authMethod : 'password';
  const storedSecret = keepsStoredSecret(draft, site);
  const allErrors = validateDraft(draft, { storedSecret });
  const errors: SiteDraftErrors = showErrors ? allErrors : {};
  const currentKey = connectionKey(draft);
  const needsTest = initialKey === null || currentKey !== initialKey;
  const tested = test !== null && test.result.ok && test.key === currentKey;
  const testStale = test !== null && test.key !== currentKey;
  const canSave = !needsTest || tested;
  const busy = saving || testing;

  function update(change: (current: SiteDraft) => SiteDraft): void {
    setDraft(change);
    setProblem(null);
  }

  function set<K extends keyof SiteDraft>(key: K, value: SiteDraft[K]): void {
    update((current) => ({ ...current, [key]: value }));
  }

  function focusField(field: SiteDraftField): void {
    document.getElementById(id(field))?.focus();
  }

  /** Shows every error and focuses the first one in `blocking`; true when nothing blocks. */
  function check(blocking: SiteDraftErrors): boolean {
    const first = firstError(blocking);
    if (!first) return true;
    setShowErrors(true);
    focusField(first);
    return false;
  }

  async function runTest(next: SiteDraft = draft): Promise<void> {
    if (testing) return;
    if (!check(testBlockers(validateDraft(next, { storedSecret }), 'test'))) return;
    const input = draftToInput(next, savedServer?.nickname);
    setTesting(true);
    setTestFailure(null);
    setResolvedRoot(null);
    // The last answer, kept for when the user declines a saved server's new key.
    const seen: { last: FilesTestResult | null } = { last: null };
    const attempt = async (): Promise<FilesTestResult> => {
      seen.last = null;
      const result = await window.runova.deployFiles.test({
        siteId: site?.id ?? null,
        site: input,
      });
      seen.last = result;
      // A saved server's key lives in Remote, so a changed one is asked about the way Remote asks.
      if (usesSavedFor(next) && result.error?.code === 'hostKeyChanged') {
        throw filesError('hostKeyChanged', result.error.message);
      }
      return result;
    };
    try {
      let result: FilesTestResult;
      if (usesSavedFor(next)) {
        try {
          result = await withHostKeyTrust(next.sshServerId, attempt);
        } catch (error) {
          if (!seen.last) throw error;
          result = seen.last;
        }
      } else {
        result = await attempt();
      }
      let testedDraft = next;
      const resolved = result.remoteRoot;
      if (resolved && resolved !== next.remoteRoot.trim()) {
        testedDraft = { ...next, remoteRoot: resolved };
        setResolvedRoot(resolved);
        setDraft((current) =>
          current.remoteRoot.trim() === next.remoteRoot.trim()
            ? { ...current, remoteRoot: resolved }
            : current,
        );
      }
      setTest({ result, key: connectionKey(testedDraft) });
    } catch (error) {
      setTest(null);
      setTestFailure(filesProblem(error));
    } finally {
      setTesting(false);
    }
  }

  function trustAndRetest(trust: Parameters<typeof withTrust>[1]): void {
    const next = withTrust(draft, trust);
    setDraft(next);
    void runTest(next);
  }

  /**
   * A login of the site's own keeps the key in the form, saved with the site. A saved server's key
   * belongs to Remote, so it is trusted there (main checks the server still shows it).
   */
  async function trustHostKey(fingerprint: string): Promise<void> {
    if (!usesSaved) {
      trustAndRetest({ hostKeyFingerprint: fingerprint });
      return;
    }
    try {
      await window.runova.ssh.trustHostKey(draft.sshServerId, fingerprint);
    } catch (error) {
      setTestFailure(filesProblem(error));
      return;
    }
    void runTest(draft);
  }

  async function save(skipTest: boolean): Promise<void> {
    if (busy) return;
    if (!check(allErrors)) return;
    if (!skipTest && !canSave) return;
    if (draft.protocol === 'ftp' && site?.protocol !== 'ftp' && !ftpConfirmed) {
      const confirmed = await confirmDialog({
        title: 'Save a site that uses plain FTP?',
        description:
          'Plain FTP sends the password and every file unencrypted. Anyone on the network between this computer and the server can read them, or change files on the way.',
        warning: 'Use FTPS or SFTP instead if your host offers either.',
        icon: TriangleAlert,
        confirmLabel: 'Use plain FTP',
        variant: 'destructive',
      });
      if (!confirmed) return;
      setFtpConfirmed(true);
    }
    setSaving(true);
    setProblem(null);
    try {
      const input = draftToInput(draft, savedServer?.nickname);
      const saved = site
        ? await window.runova.deployFiles.update(site.id, input)
        : await window.runova.deployFiles.create(input);
      toast.success(site ? `Saved ${saved.label}.` : `Added ${saved.label}.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployFilesSites });
      setDraft((current) => ({ ...current, secret: '' }));
      onOpenChange(false);
      onSaved(saved);
    } catch (error) {
      setProblem(filesProblem(error));
    } finally {
      setSaving(false);
    }
  }

  /** Enter and the form's submit: show what's missing, else test, else save. */
  async function primaryAction(): Promise<void> {
    if (busy) return;
    if (!check(allErrors)) return;
    if (!canSave) {
      await runTest();
      return;
    }
    await save(false);
  }

  function openBrowser(next: boolean): void {
    if (!next) {
      setBrowsing(false);
      return;
    }
    if (!check(testBlockers(allErrors, 'browse'))) return;
    setBrowsing(true);
  }

  async function pickLocalFolder(): Promise<void> {
    const start = draft.localFolder.trim() || sourceProject?.folderPath || null;
    const picked = await window.runova.deployFiles.pickLocalFolder(start);
    if (picked) set('localFolder', picked);
  }

  async function pickKeyFile(): Promise<void> {
    const picked = await window.runova.ssh.pickPrivateKeyFile();
    if (picked) set('privateKeyPath', picked);
  }

  const title = site ? `Edit ${site.label}` : 'Add an FTP or SFTP site';
  const firstFieldId = usesSaved ? id('sshServerId') : id('host');
  const remoteRootTrimmed = draft.remoteRoot.trim();
  const secretPlaceholder = storedSecret ? 'Saved, leave empty to keep it' : undefined;
  const pinsShown =
    !usesSaved &&
    draft.trustedFor === `${draft.host.trim().toLowerCase()}:${draft.port.trim()}` &&
    ((sftp && draft.hostKeyFingerprint) ||
      (draft.protocol === 'ftps' && (draft.tlsPin || draft.tlsServername)));

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : onOpenChange(false))}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(42rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(firstFieldId)?.focus();
        }}
      >
        <form
          ref={formRef}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void primaryAction();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            const target = event.target as HTMLElement;
            // Only the form's own text fields; lists in popovers handle their own Enter.
            if (target.tagName !== 'INPUT' || !formRef.current?.contains(target)) return;
            event.preventDefault();
            void primaryAction();
          }}
        >
          <DialogHeader className="px-5 py-4 pr-12 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
            <DialogTitle className="flex items-center gap-2 text-base">
              {site ? (
                <Pencil className="h-4 w-4 text-primary" />
              ) : (
                <Upload className="h-4 w-4 text-primary" />
              )}
              {title}
            </DialogTitle>
            <DialogDescription className="text-xs">
              A folder on this computer, sent to a folder on a server. You review what changed
              before anything is sent.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
            <Section title="Server">
              <div className="space-y-2">
                <PillTabs
                  id={`${ids}-protocol`}
                  label="Protocol"
                  kind="toggle"
                  items={PROTOCOLS}
                  value={draft.protocol}
                  onChange={(protocol) => update((current) => withProtocol(current, protocol))}
                  className="w-fit"
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {PROTOCOL_DESCRIPTION[draft.protocol]}
                </p>
                {draft.protocol === 'ftp' && (
                  <Notice tone="warning" size="sm">
                    Plain FTP is not encrypted. Your password and every file cross the network as
                    readable text. Pick FTPS or SFTP if your host offers either.
                  </Notice>
                )}
              </div>

              {sftp && (
                <PillTabs
                  id={`${ids}-source`}
                  label="Login"
                  kind="toggle"
                  size="xs"
                  items={[
                    { value: 'custom', label: 'Enter a login' },
                    { value: 'saved', label: 'Saved server' },
                  ]}
                  value={draft.source}
                  onChange={(source) => set('source', source)}
                  className="w-fit"
                />
              )}

              {usesSaved ? (
                <Field
                  id={id('sshServerId')}
                  label="Server"
                  error={errors.sshServerId}
                  hint={
                    savedServer
                      ? `${savedServer.username}@${savedServer.host}:${savedServer.port}`
                      : servers.isSuccess && serverList.length === 0
                        ? 'No servers are saved in Remote yet. Add one there, or enter a login here.'
                        : 'Uses the login and the trusted host key saved in Remote.'
                  }
                >
                  <Combobox
                    id={id('sshServerId')}
                    value={draft.sshServerId}
                    onChange={(value) => set('sshServerId', value)}
                    placeholder="Pick a saved server"
                    searchPlaceholder="Search servers…"
                    emptyText="No saved server matches."
                    invalid={Boolean(errors.sshServerId)}
                    ariaDescribedBy={
                      errors.sshServerId
                        ? `${id('sshServerId')}-error`
                        : `${id('sshServerId')}-hint`
                    }
                    options={serverList.map((one) => ({
                      value: one.id,
                      label: `${one.nickname} (${one.username}@${one.host})`,
                      keywords: [one.host, one.username],
                      icon: <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
                    }))}
                  />
                </Field>
              ) : (
                <>
                  <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
                    <Field id={id('host')} label="Host" error={errors.host}>
                      <Input
                        id={id('host')}
                        value={draft.host}
                        onChange={(event) =>
                          update((current) => withHost(current, event.target.value))
                        }
                        placeholder={sftp ? 'ssh.example.com' : 'ftp.example.com'}
                        spellCheck={false}
                        autoComplete="off"
                        {...described(id('host'), errors.host, false)}
                      />
                    </Field>
                    <Field id={id('port')} label="Port" error={errors.port}>
                      <Input
                        id={id('port')}
                        value={draft.port}
                        onChange={(event) =>
                          update((current) => withPort(current, event.target.value))
                        }
                        inputMode="numeric"
                        autoComplete="off"
                        {...described(id('port'), errors.port, false)}
                      />
                    </Field>
                  </div>
                  <Field id={id('username')} label="Username" error={errors.username}>
                    <Input
                      id={id('username')}
                      value={draft.username}
                      onChange={(event) => set('username', event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      {...described(id('username'), errors.username, false)}
                    />
                  </Field>

                  {sftp && (
                    <PillTabs
                      id={`${ids}-auth`}
                      label="Sign in with"
                      kind="toggle"
                      size="xs"
                      items={[
                        { value: 'password', label: 'Password' },
                        { value: 'privateKey', label: 'Private key' },
                      ]}
                      value={draft.authMethod}
                      onChange={(value) => update((current) => withAuthMethod(current, value))}
                      className="w-fit"
                    />
                  )}

                  {authMethod === 'privateKey' ? (
                    <>
                      <Field
                        id={id('privateKeyPath')}
                        label="Private key file"
                        error={errors.privateKeyPath}
                      >
                        <div className="flex gap-2">
                          <Input
                            id={id('privateKeyPath')}
                            value={draft.privateKeyPath}
                            onChange={(event) => set('privateKeyPath', event.target.value)}
                            placeholder="~/.ssh/id_ed25519"
                            spellCheck={false}
                            autoComplete="off"
                            className="flex-1 font-mono text-[13px]"
                            {...described(id('privateKeyPath'), errors.privateKeyPath, false)}
                          />
                          <SimpleTooltip label="Choose key file">
                            <Button
                              type="button"
                              variant="soft"
                              size="icon"
                              aria-label="Choose key file"
                              onClick={() => void pickKeyFile()}
                            >
                              <FolderOpen />
                            </Button>
                          </SimpleTooltip>
                        </div>
                      </Field>
                      <Field
                        id={id('secret')}
                        label="Key passphrase"
                        optional
                        hint={
                          storedSecret
                            ? undefined
                            : 'Only needed when the key itself has a passphrase.'
                        }
                      >
                        <SecretInput
                          id={id('secret')}
                          value={draft.secret}
                          onChange={(value) => set('secret', value)}
                          placeholder={secretPlaceholder}
                          {...described(id('secret'), undefined, !storedSecret)}
                        />
                      </Field>
                    </>
                  ) : (
                    <Field id={id('secret')} label="Password" error={errors.secret}>
                      <SecretInput
                        id={id('secret')}
                        value={draft.secret}
                        onChange={(value) => set('secret', value)}
                        placeholder={secretPlaceholder}
                        {...described(id('secret'), errors.secret, false)}
                      />
                    </Field>
                  )}

                  {pinsShown && (
                    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <CircleCheck className="mt-px h-3.5 w-3.5 shrink-0 text-success" />
                      <span>
                        {sftp
                          ? 'Its host key is trusted. A server that shows a different one is refused.'
                          : [
                              draft.tlsServername &&
                                `The certificate is checked against ${draft.tlsServername}.`,
                              draft.tlsPin && 'Its certificate is trusted for this site.',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                      </span>
                    </p>
                  )}
                </>
              )}
            </Section>

            <Section title="Folders">
              <Field
                id={id('localFolder')}
                label="Deploy folder"
                error={errors.localFolder}
                hint={
                  sourceProject && draft.localFolder === sourceProject.folderPath
                    ? `The folder of ${sourceProject.name}. Pick its build output instead if that is what goes live.`
                    : 'Everything in it is sent, except what the ignore rules leave out.'
                }
              >
                <div className="flex gap-2">
                  <Input
                    id={id('localFolder')}
                    value={draft.localFolder}
                    onChange={(event) => set('localFolder', event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    className="flex-1 font-mono text-[13px]"
                    {...described(id('localFolder'), errors.localFolder, true)}
                  />
                  <Button type="button" variant="soft" onClick={() => void pickLocalFolder()}>
                    <FolderOpen />
                    Choose…
                  </Button>
                </div>
              </Field>
              <Field
                id={id('remoteRoot')}
                label="Folder on the server"
                error={errors.remoteRoot}
                hint="The site's own folder, often /public_html or /var/www/your-site."
              >
                <div className="flex gap-2">
                  <Input
                    id={id('remoteRoot')}
                    value={draft.remoteRoot}
                    onChange={(event) => set('remoteRoot', event.target.value)}
                    placeholder="/public_html"
                    spellCheck={false}
                    autoComplete="off"
                    className="flex-1 font-mono text-[13px]"
                    {...described(id('remoteRoot'), errors.remoteRoot, true)}
                  />
                  <RemoteFolderBrowser
                    open={browsing}
                    onOpenChange={openBrowser}
                    siteId={site?.id ?? null}
                    site={draftToInput(draft, savedServer?.nickname)}
                    target={browseTarget(draft, site?.id ?? null)}
                    initialPath={remoteRootTrimmed.startsWith('/') ? remoteRootTrimmed : null}
                    onPick={(path) => set('remoteRoot', path)}
                  >
                    <Button type="button" variant="soft">
                      <FolderTree />
                      Browse
                    </Button>
                  </RemoteFolderBrowser>
                </div>
              </Field>
              {remoteRootTrimmed === '/' && (
                <Notice tone="warning" size="sm">
                  This is the top folder of the server. A deploy could then touch any file this
                  login can write. Pick the site's own folder unless the login only sees the site.
                </Notice>
              )}
              {resolvedRoot && resolvedRoot === remoteRootTrimmed && (
                <Notice size="sm">
                  The server calls this folder {resolvedRoot}, so the field now says that.
                </Notice>
              )}
            </Section>

            <Section
              title="Connection"
              description="Signs in, finds the folder, then writes, replaces and removes a small test file. Nothing else on the server is touched."
            >
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  disabled={testing}
                  aria-busy={testing || undefined}
                  onClick={() => void runTest()}
                >
                  {testing ? <Spinner className="animate-spin" /> : <CircleCheck />}
                  {testing ? 'Testing…' : 'Test connection'}
                </Button>
                {tested && <span className="text-xs text-success">Tested with these details.</span>}
                {testStale && !testing && (
                  <span className="text-xs text-muted-foreground">
                    The details changed since the last test. Test again before saving.
                  </span>
                )}
              </div>
              <TestConnectionChecklist
                result={test?.result ?? null}
                testing={testing}
                failure={testFailure}
                host={draft.host.trim()}
                onTrustHostKey={(fingerprint) => void trustHostKey(fingerprint)}
                onUseServername={(name) => trustAndRetest({ tlsServername: name })}
                onTrustCertificate={(fingerprint) => trustAndRetest({ tlsPin: fingerprint })}
              />
            </Section>

            <Section title="Projects and options">
              <Field
                id={id('projects')}
                label="Projects"
                hint="The site shows on each attached project's Deploy tab."
              >
                <ProjectMultiPicker
                  id={id('projects')}
                  value={draft.projectIds}
                  onChange={(projectIds) => set('projectIds', projectIds)}
                  projects={projectList}
                  ariaDescribedBy={`${id('projects')}-hint`}
                />
              </Field>

              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor={id('deployOnSave')}>Deploy on save</Label>
                  <p
                    id={`${id('deployOnSave')}-description`}
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    Sends changes by itself once the folder has been quiet for a moment. It never
                    resolves a conflict or deletes many files on its own; those wait for you.
                  </p>
                </div>
                <Switch
                  id={id('deployOnSave')}
                  checked={draft.deployOnSave}
                  onCheckedChange={(checked) => set('deployOnSave', checked)}
                  aria-describedby={`${id('deployOnSave')}-description`}
                />
              </div>
              {draft.deployOnSave && (
                <Field
                  id={id('quietSeconds')}
                  label="Quiet time in seconds"
                  error={errors.quietSeconds}
                  hint={`How long after the last change to wait, ${MIN_QUIET_SECONDS} to ${MAX_QUIET_SECONDS} seconds.`}
                >
                  <Input
                    id={id('quietSeconds')}
                    type="number"
                    min={MIN_QUIET_SECONDS}
                    max={MAX_QUIET_SECONDS}
                    inputMode="numeric"
                    value={draft.quietSeconds}
                    onChange={(event) => set('quietSeconds', event.target.value)}
                    className="w-28"
                    {...described(id('quietSeconds'), errors.quietSeconds, true)}
                  />
                </Field>
              )}

              <Field
                id={id('label')}
                label="Name"
                optional
                error={errors.label}
                hint="How the site is listed in Deploy."
              >
                <Input
                  id={id('label')}
                  value={draft.label}
                  maxLength={100}
                  onChange={(event) => set('label', event.target.value)}
                  placeholder={defaultLabel(draft, savedServer?.nickname)}
                  autoComplete="off"
                  {...described(id('label'), errors.label, true)}
                />
              </Field>
            </Section>

            {problem && <Problem message={problem} />}
          </div>

          <DialogFooter
            className={cn(FOOTER_HAIRLINE, 'flex-row items-center gap-2 px-5 py-3 sm:justify-end')}
          >
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {needsTest && !tested && (
              <Button
                type="button"
                variant="soft"
                size="sm"
                disabled={busy}
                onClick={() => void save(true)}
              >
                Save without testing
              </Button>
            )}
            <SimpleTooltip
              label={canSave ? null : 'Test the connection first, or save without testing.'}
              wrapTrigger
            >
              <Button
                type="button"
                size="sm"
                disabled={!canSave || busy}
                aria-busy={saving || undefined}
                onClick={() => void save(false)}
              >
                {saving && <Spinner className="h-3.5 w-3.5 animate-spin" />}
                {site ? 'Save changes' : 'Add site'}
              </Button>
            </SimpleTooltip>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function usesSavedFor(draft: SiteDraft): boolean {
  return draft.protocol === 'sftp' && draft.source === 'saved';
}
