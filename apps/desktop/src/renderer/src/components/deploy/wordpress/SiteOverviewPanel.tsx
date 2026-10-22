import { WP_CONNECTOR_VERSION, WP_PROTOCOL_VERSION } from '@agentmat/core';
import type { DeployWordPressSite, DeployWordPressSiteInfo } from '@shared/deployWordPressTypes';
import { wordPressErrorCode } from '@shared/wordpressErrors';
import {
  ArrowUp,
  CircleCheck,
  CircleInfo,
  Clock,
  Plug,
  RefreshCw,
  Shield,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { WordPressMark } from '@/components/wordpress/WordPressMark';
import { cn } from '@/lib/utils';
import { DeployCard, FactRow, FactRows, Notice } from '../deployKit';
import { SetupFailure } from '../SetupFailure';
import { ConnectorDownloadCard } from './ConnectorDownloadCard';
import {
  type ConnectorUpdate,
  useSaveConnectorZip,
  useSiteInfo,
  useUpdateConnector,
} from './hooks';
import {
  compareVersions,
  DEPLOY_STATE_LABEL,
  dateTimeText,
  fileChangesStatus,
  siteClockText,
  TRANSPORT_LABEL,
  wpProblem,
} from './messages';

function CardSkeleton({ rows }: { rows: number }): React.JSX.Element {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-6 w-full" />
      ))}
    </div>
  );
}

/** A short line with a mark that says good, bad or not known, in words as well as colour. */
function Status({
  tone,
  children,
}: {
  tone: 'good' | 'bad' | 'neutral';
  children: React.ReactNode;
}): React.JSX.Element {
  const Icon = tone === 'good' ? CircleCheck : tone === 'bad' ? TriangleAlert : CircleInfo;
  return (
    <span className="flex items-start gap-1.5">
      <Icon
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          tone === 'good' && 'text-success',
          tone === 'bad' && 'text-warning',
          tone === 'neutral' && 'text-muted-foreground',
        )}
      />
      <span>{children}</span>
    </span>
  );
}

/**
 * A newer connector of the same protocol: worth having, not needed. A connector that can replace
 * itself is updated from here; an older one has to be uploaded in wp-admin once, and says so.
 */
function NewerConnector({
  info,
  site,
  connectorUpdate,
}: {
  info: DeployWordPressSiteInfo;
  site: DeployWordPressSite;
  connectorUpdate: ConnectorUpdate;
}): React.JSX.Element {
  const { save, saving } = useSaveConnectorZip();
  const changes = fileChangesStatus(info, site);
  const download = (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 text-xs"
      disabled={saving}
      onClick={() => void save()}
    >
      Download version {WP_CONNECTOR_VERSION}
    </Button>
  );

  if (info.selfUpdate === true && changes.allowed) {
    return (
      <span className="mt-1.5 block text-xs text-muted-foreground">
        Version {WP_CONNECTOR_VERSION} comes with this app.
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button
            size="sm"
            disabled={connectorUpdate.updating}
            onClick={() => void connectorUpdate.update()}
          >
            {connectorUpdate.updating ? (
              <Spinner className="motion-safe:animate-spin" />
            ) : (
              <ArrowUp />
            )}
            {connectorUpdate.updating ? 'Updating' : `Update to ${WP_CONNECTOR_VERSION}`}
          </Button>
          {download}
        </span>
      </span>
    );
  }

  let why: string;
  if (info.selfUpdate === true) {
    why =
      site.scope === 'read'
        ? "This connection is read-only, so it can't update the connector from here. Make a read and write key in Tools > AgentMate Connector, or upload the new one in wp-admin."
        : "File changes are switched off on this site (see File changes below), so the connector can't be updated from here. Upload the new one in wp-admin when it suits you.";
  } else if (info.selfUpdate === false) {
    why =
      "This one still works, but it can't replace its own folder here (it may be a symlink or not writable). Upload the new one in wp-admin when it suits you.";
  } else {
    why =
      'This one still works; upload the new one in wp-admin when it suits you. After this one upload, future updates can be done from here.';
  }
  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      Version {WP_CONNECTOR_VERSION} comes with this app. {why} {download}
    </span>
  );
}

/** What the last in-app connector update did, kept on screen after the version row is gone. */
function ConnectorUpdateNotice({
  connectorUpdate,
}: {
  connectorUpdate: ConnectorUpdate;
}): React.JSX.Element | null {
  const { result, problem } = connectorUpdate;
  if (problem) {
    return (
      <Notice role="alert" tone="destructive" icon={TriangleAlert}>
        {problem}
      </Notice>
    );
  }
  if (result?.outcome === 'updated') {
    return (
      <Notice role="status" tone="success">
        The connector on this site is now version {result.version} (it was {result.fromVersion}).
        {result.source === 'site' && ' The site downloaded it from GitHub itself.'}
        {result.downloadProblem && (
          <>
            {" The site couldn't download it itself, so AgentMate sent the files. "}
            <span className="text-muted-foreground">{result.downloadProblem}</span>
          </>
        )}
        {result.checks.some((check) => check.ok === true) &&
          ' The site passed its health check after the swap.'}
      </Notice>
    );
  }
  if (result?.outcome === 'rolledBack') {
    const failed = result.checks.filter((check) => check.ok === false);
    return (
      <Notice role="alert" tone="warning" icon={TriangleAlert}>
        The site failed its health check with version {result.version}, so it put version{' '}
        {result.fromVersion} back on its own.
        {failed.length > 0 && (
          <> It failed: {failed.map((check) => `${check.name} (${check.detail})`).join(', ')}.</>
        )}{' '}
        Nothing else on the site changed.
      </Notice>
    );
  }
  return null;
}

function ConnectorNotice({ info }: { info: DeployWordPressSiteInfo }): React.JSX.Element | null {
  if (info.protocol < WP_PROTOCOL_VERSION) {
    return (
      <div className="flex flex-col gap-2">
        <Notice role="alert" tone="warning" icon={TriangleAlert}>
          The connector on this site ({info.pluginVersion}) is older than this version of AgentMate
          expects, so pulls and deploys may fail. Download the latest plugin below and upload it in
          the site's admin. Uploading it over the old one keeps the connection.
        </Notice>
        <ConnectorDownloadCard title="Update the connector" />
      </div>
    );
  }
  if (info.protocol > WP_PROTOCOL_VERSION) {
    return (
      <Notice role="alert" tone="warning" icon={TriangleAlert}>
        The connector on this site is newer than this version of AgentMate. Update AgentMate so the
        two speak the same language.
      </Notice>
    );
  }
  return null;
}

/**
 * What the site runs and whether it is in shape for a deploy: WordPress and PHP versions, the
 * active theme, HTTPS, the connector, whether file changes are allowed and why not, the rescue
 * guard, loopback health and any deploy still waiting for its confirmation.
 */
export function SiteOverviewPanel({ site }: { site: DeployWordPressSite }): React.JSX.Element {
  const infoQuery = useSiteInfo(site.id);
  const connectorUpdate = useUpdateConnector(site.id);
  const info = infoQuery.data;
  const loading = infoQuery.isPending;
  const errorCode = infoQuery.isError ? wordPressErrorCode(infoQuery.error) : null;
  const newerConnector = info
    ? compareVersions(info.pluginVersion, WP_CONNECTOR_VERSION) < 0
    : false;

  return (
    <div className="flex flex-col gap-2">
      {infoQuery.isError && (
        <div className="flex flex-col items-start gap-2">
          <div className="w-full">
            <SetupFailure message={wpProblem(infoQuery.error)} />
          </div>
          <Button
            size="sm"
            variant="soft"
            disabled={infoQuery.isFetching}
            onClick={() => void infoQuery.refetch()}
          >
            <RefreshCw /> Try again
          </Button>
          {errorCode === 'connectorOutdated' && (
            <ConnectorDownloadCard title="Update the connector" className="w-full" />
          )}
        </div>
      )}
      {info && <ConnectorNotice info={info} />}
      <ConnectorUpdateNotice connectorUpdate={connectorUpdate} />
      {info?.pendingDeploy && (
        <Notice role="status" tone="primary" icon={Clock}>
          A deploy is waiting for confirmation ({DEPLOY_STATE_LABEL[info.pendingDeploy.state]}). If
          it isn't confirmed by {siteClockText(info.pendingDeploy.deadline)}, the site puts the old
          files back on its own.
        </Notice>
      )}
      <div className="grid gap-2 xl:grid-cols-2">
        <DeployCard
          icon={<WordPressMark />}
          tone="neutral"
          title="Site"
          description={
            <span className="break-words">{info ? info.siteName : 'What the site runs.'}</span>
          }
          actions={
            <Button
              size="sm"
              variant="soft"
              disabled={infoQuery.isFetching}
              onClick={() => void infoQuery.refetch()}
            >
              {infoQuery.isFetching ? (
                <Spinner className="motion-safe:animate-spin" />
              ) : (
                <RefreshCw />
              )}
              Check again
            </Button>
          }
        >
          {loading ? (
            <CardSkeleton rows={6} />
          ) : !info ? (
            <p className="text-sm text-muted-foreground">The site's details did not load.</p>
          ) : (
            <FactRows>
              <FactRow label="WordPress">
                {info.wpVersion}
                {info.multisite && (
                  <span className="text-muted-foreground">, a multisite network</span>
                )}
              </FactRow>
              <FactRow label="PHP">{info.phpVersion}</FactRow>
              <FactRow label="Active theme">
                <span className="font-mono">{info.activeTheme.stylesheet}</span>
                {info.activeTheme.template !== info.activeTheme.stylesheet && (
                  <span className="block text-xs text-muted-foreground">
                    A child theme of <span className="font-mono">{info.activeTheme.template}</span>
                  </span>
                )}
              </FactRow>
              <FactRow label="HTTPS">
                {info.https ? (
                  <Status tone="good">Yes</Status>
                ) : (
                  <Status tone="bad">No, the site is served over plain HTTP</Status>
                )}
              </FactRow>
              <FactRow label="Connection">{TRANSPORT_LABEL[site.transport]}</FactRow>
              <FactRow label="Checked">{dateTimeText(info.checkedAt)}</FactRow>
            </FactRows>
          )}
        </DeployCard>

        <DeployCard
          icon={<Plug />}
          title="Connector"
          description="The AgentMate Connector plugin on the site."
        >
          {loading ? (
            <CardSkeleton rows={4} />
          ) : !info ? (
            <p className="text-sm text-muted-foreground">The connector's details did not load.</p>
          ) : (
            <FactRows>
              <FactRow label="Version">
                {info.pluginVersion}
                <span className="text-muted-foreground">, protocol {info.protocol}</span>
                {newerConnector && info.protocol === WP_PROTOCOL_VERSION && (
                  <NewerConnector info={info} site={site} connectorUpdate={connectorUpdate} />
                )}
              </FactRow>
              <FactRow label="Signing">
                {info.sodium === 'native'
                  ? 'PHP sodium extension'
                  : "WordPress's built-in sodium library (slower, works the same)"}
              </FactRow>
              <FactRow label="Rescue guard">
                {info.guard.installed ? (
                  <Status tone="good">
                    Installed. If a deploy breaks the site, the guard puts the old files back, even
                    when WordPress itself can't load.
                  </Status>
                ) : (
                  <Status tone="bad">
                    Not installed, so a deploy that breaks the site can't be rolled back on its own.
                    Deactivate and activate the connector in wp-admin to put it back.
                  </Status>
                )}
              </FactRow>
              <FactRow label="Health check">
                {info.loopback === 'ok' ? (
                  <Status tone="good">
                    The site can reach itself, so every deploy is health-checked.
                  </Status>
                ) : info.loopback === 'failed' ? (
                  <Status tone="bad">
                    The site can't reach itself (loopback requests fail), so it can't check a deploy
                    from the inside. AgentMate still checks the home page from here.
                  </Status>
                ) : (
                  <Status tone="neutral">Not checked yet.</Status>
                )}
              </FactRow>
            </FactRows>
          )}
        </DeployCard>

        <DeployCard
          className="xl:col-span-2"
          icon={<Shield />}
          title="File changes"
          description="Deploys only ever write theme, plugin and mu-plugin files. They never activate a plugin or switch the theme."
        >
          {loading ? (
            <CardSkeleton rows={2} />
          ) : !info ? (
            <p className="text-sm text-muted-foreground">Not known until the site answers.</p>
          ) : (
            <FileChanges info={info} site={site} />
          )}
        </DeployCard>
      </div>
    </div>
  );
}

function FileChanges({
  info,
  site,
}: {
  info: DeployWordPressSiteInfo;
  site: DeployWordPressSite;
}): React.JSX.Element {
  const status = fileChangesStatus(info, site);
  return (
    <FactRows>
      <FactRow label="Deploys">
        <Status tone={status.allowed ? 'good' : 'bad'}>{status.text}</Status>
      </FactRow>
      {info.fileEditDisabled && (
        <FactRow label="Built-in editors">
          Off (DISALLOW_FILE_EDIT). That only hides the theme and plugin editors in wp-admin;
          deploys still work.
        </FactRow>
      )}
      {!status.allowed && info.filesystemMethod !== 'direct' && (
        <FactRow label="Filesystem">
          <span className="font-mono">{info.filesystemMethod}</span>
        </FactRow>
      )}
    </FactRows>
  );
}
