import type { FileSite, FilesNeedsReview } from '@shared/deployFilesTypes';
import { CloudUpload, History, SettingsIcon } from '@/components/icons';
import { Chip, GLASS_CARD, Notice, PillTabs } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { lastDeployText } from './copy';
import { DeployPanel } from './DeployPanel';
import { FileSiteSettings } from './FileSiteSettings';
import { FilesHistoryPanel } from './FilesHistoryPanel';
import { useCachedFileSiteChanges, useSavedServerNames } from './hooks';
import { PROTOCOL_DESCRIPTION, siteAddress } from './messages';
import { NotEncryptedChip, ProtocolChip } from './parts';

/** The parts of an FTP or SFTP site's page under Deploy (E23). */
export type FileSiteSection = 'changes' | 'history' | 'settings';

const SECTIONS: FileSiteSection[] = ['changes', 'history', 'settings'];

/** Reads a section from the page's address (`?view=`); anything unknown is Changes. */
export function fileSectionFromView(view: string | null): FileSiteSection {
  return SECTIONS.find((section) => section === view) ?? 'changes';
}

const NEEDS_REVIEW_TITLE: Record<FilesNeedsReview['reason'], string> = {
  conflicts: 'Deploy on save stopped: some files need your choice',
  massDelete: 'Deploy on save stopped: this deploy would delete many files',
  failed: 'Deploy on save stopped after a deploy failed',
  paused: 'Deploy on save is paused',
};

/** Why Deploy on save stopped and is waiting, with the way to review the changes. */
export function NeedsReviewNotice({
  needsReview,
  onReview,
}: {
  needsReview: FilesNeedsReview;
  onReview: () => void;
}): React.JSX.Element {
  return (
    <Notice
      role="status"
      aria-label="Deploy on save stopped"
      tone="warning"
      className="shrink-0"
      action={
        <Button size="sm" onClick={onReview}>
          Review the changes
        </Button>
      }
    >
      <p className="font-medium">{NEEDS_REVIEW_TITLE[needsReview.reason]}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{needsReview.message}</p>
    </Notice>
  );
}

/** A site's name, address and the facts that change what a deploy to it means. */
export function FileSiteHeader({ site }: { site: FileSite }): React.JSX.Element {
  const names = useSavedServerNames();
  const savedName =
    site.connection.kind === 'saved' ? (names.get(site.connection.sshServerId) ?? null) : null;
  return (
    <header className={cn(GLASS_CARD, 'flex shrink-0 flex-wrap items-center gap-3 px-4 py-3')}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary shadow-[0_0_28px_-12px_hsl(var(--primary)/0.7)]">
        <CloudUpload className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold leading-tight tracking-tight text-foreground">
          {site.label}
        </h2>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {siteAddress(site, savedName)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <SimpleTooltip label={PROTOCOL_DESCRIPTION[site.protocol]} className="max-w-xs">
          <ProtocolChip
            protocol={site.protocol}
            tabIndex={0}
            className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </SimpleTooltip>
        {site.protocol === 'ftp' && <NotEncryptedChip focusable />}
        {site.deployOnSave && (
          <Chip tone="primary" dot>
            Deploy on save
          </Chip>
        )}
        {site.needsReview && <Chip tone="warning">Needs review</Chip>}
      </div>
      <span className="ml-auto text-xs text-muted-foreground">
        {lastDeployText(site.lastDeploy)}
      </span>
    </header>
  );
}

/**
 * An FTP or SFTP site's page under Deploy: its header, a note when Deploy on save stopped, the
 * section strip and the section shown. Changes is the default.
 */
export function FileSiteView({
  site,
  section,
  onSectionChange,
  onEdit,
  onRemoved,
}: {
  site: FileSite;
  section: FileSiteSection;
  onSectionChange: (section: FileSiteSection) => void;
  /** Opens the edit dialog for this site. */
  onEdit: () => void;
  onRemoved: () => void;
}): React.JSX.Element {
  const cached = useCachedFileSiteChanges(site.id);

  let content: React.ReactNode;
  if (section === 'history') content = <FilesHistoryPanel siteId={site.id} />;
  else if (section === 'settings') {
    content = <FileSiteSettings key={site.id} site={site} onEdit={onEdit} onRemoved={onRemoved} />;
  } else {
    content = (
      <DeployPanel
        site={site}
        onEdit={onEdit}
        onOpenSettings={() => onSectionChange('settings')}
        showLastDeploy={false}
      />
    );
  }

  return (
    <>
      <FileSiteHeader site={site} />
      {site.needsReview && (
        <NeedsReviewNotice
          needsReview={site.needsReview}
          onReview={() => {
            onSectionChange('changes');
            useDeployFilesRunStore.getState().requestStart(site.id);
          }}
        />
      )}
      <PillTabs
        id="file-site-sections"
        label="Site sections"
        className="shrink-0 self-start"
        value={section}
        onChange={onSectionChange}
        items={[
          {
            value: 'changes',
            label: 'Changes',
            icon: <CloudUpload />,
            count: cached?.files.length ?? 0,
          },
          { value: 'history', label: 'History', icon: <History /> },
          { value: 'settings', label: 'Settings', icon: <SettingsIcon /> },
        ]}
      />
      {content}
    </>
  );
}
