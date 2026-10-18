import { Blocks, Folder, History, Key, LayoutDashboard } from '@/components/icons';
import { SectionStrip } from '../deployKit';

/** The parts of a WordPress site's page under Deploy. */
export type SiteSection = 'overview' | 'items' | 'projects' | 'deploys' | 'access';

const SECTIONS: ReadonlyArray<{ value: SiteSection; label: string; icon?: typeof Blocks }> = [
  { value: 'overview', label: 'Overview', icon: LayoutDashboard },
  { value: 'items', label: 'Themes and plugins', icon: Blocks },
  { value: 'projects', label: 'Projects', icon: Folder },
  { value: 'deploys', label: 'Deploys', icon: History },
  { value: 'access', label: 'Access', icon: Key },
];

/** Reads a section from the page's address (`?view=`); anything unknown is the Overview. */
export function siteSectionFromView(view: string | null): SiteSection {
  return SECTIONS.find((section) => section.value === view)?.value ?? 'overview';
}

/** Switches between a site's sections, the same way a server's section strip does. */
export function SiteSections({
  value,
  onChange,
}: {
  value: SiteSection;
  onChange: (section: SiteSection) => void;
}): React.JSX.Element {
  return (
    <SectionStrip
      id="site-sections"
      label="Site sections"
      items={SECTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
