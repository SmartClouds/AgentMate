import {
  Archive,
  Bell,
  Blocks,
  Docker,
  FileText,
  FolderOpen,
  Globe,
  LayoutDashboard,
  Lock,
  Shield,
  Store,
} from '@/components/icons';
import { SectionStrip } from './deployKit';

/** The parts of a server's page under Deploy. */
export type ServerSection =
  | 'overview'
  | 'apps'
  | 'containers'
  | 'files'
  | 'store'
  | 'websites'
  | 'firewall'
  | 'logs'
  | 'backups'
  | 'security'
  | 'notifications';

const SECTIONS: ReadonlyArray<{ value: ServerSection; label: string; icon?: typeof Shield }> = [
  { value: 'overview', label: 'Overview', icon: LayoutDashboard },
  { value: 'apps', label: 'Apps', icon: Blocks },
  { value: 'containers', label: 'Containers', icon: Docker },
  { value: 'files', label: 'Files', icon: FolderOpen },
  { value: 'store', label: 'App Store', icon: Store },
  { value: 'websites', label: 'Websites', icon: Globe },
  { value: 'firewall', label: 'Firewall', icon: Lock },
  { value: 'logs', label: 'Logs', icon: FileText },
  { value: 'backups', label: 'Backups', icon: Archive },
  { value: 'security', label: 'Security', icon: Shield },
  { value: 'notifications', label: 'Notifications', icon: Bell },
];

/** Reads a section from the page's address; anything unknown is the Overview. */
export function sectionFromView(view: string | null): ServerSection {
  return SECTIONS.find((section) => section.value === view)?.value ?? 'overview';
}

/** Switches between a server's sections, the pill strip every Deploy page uses. */
export function ServerSections({
  value,
  onChange,
}: {
  value: ServerSection;
  onChange: (section: ServerSection) => void;
}): React.JSX.Element {
  return (
    <SectionStrip
      id="server-sections"
      label="Server sections"
      items={SECTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
