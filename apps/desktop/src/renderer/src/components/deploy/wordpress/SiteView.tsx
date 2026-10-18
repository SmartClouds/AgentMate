import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { SiteAccessPanel } from './SiteAccessPanel';
import { SiteDeploysPanel } from './SiteDeploysPanel';
import { SiteHeader } from './SiteHeader';
import { SiteItemsPanel } from './SiteItemsPanel';
import { SiteOverviewPanel } from './SiteOverviewPanel';
import { SiteProjectsPanel } from './SiteProjectsPanel';
import { type SiteSection, SiteSections } from './SiteSections';

/** A WordPress site's page under Deploy: its header, the section strip and the section shown. */
export function SiteView({
  site,
  section,
  onSectionChange,
  onDisconnected,
}: {
  site: DeployWordPressSite;
  section: SiteSection;
  onSectionChange: (section: SiteSection) => void;
  onDisconnected: () => void;
}): React.JSX.Element {
  let content: React.ReactNode;
  if (section === 'items') content = <SiteItemsPanel site={site} />;
  else if (section === 'projects') content = <SiteProjectsPanel site={site} />;
  else if (section === 'deploys') content = <SiteDeploysPanel site={site} />;
  else if (section === 'access') {
    content = <SiteAccessPanel key={site.id} site={site} onDisconnected={onDisconnected} />;
  } else content = <SiteOverviewPanel site={site} />;

  return (
    <>
      <SiteHeader site={site} />
      <SiteSections value={section} onChange={onSectionChange} />
      {content}
    </>
  );
}
