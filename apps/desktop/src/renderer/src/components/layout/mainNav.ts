import type { UpdateStatus } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { matchPath } from 'react-router-dom';
import { toast } from 'sonner';
import { openIncidentCount } from '@/components/health/healthView';
import type { IconProps } from '@/components/icons';
import {
  Android,
  Blocks,
  ChartColumn,
  CircleQuestion,
  Clapperboard,
  Docker,
  FolderKanban,
  Github,
  HeartPulse,
  LayoutDashboard,
  MessageSquare,
  Monitor,
  Plug,
  Rocket,
  Send,
  SettingsIcon,
  Sparkles,
  TerminalSquare,
  Vault,
  Workspace,
  Wrench,
} from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { openUpdateDialog, useUpdateStore } from '@/stores/updateStore';

/**
 * The main menu's destinations and the state both of its layouts show: the sidebar down the
 * left and the menu bar along the top read everything from here, so the two never disagree.
 */

/** The headed sections of the menu, in the order they are shown. */
export const NAV_GROUPS = ['Build', 'Agents', 'Ship', 'Connect'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export interface NavItem {
  to: string;
  label: string;
  icon: React.ForwardRefExoticComponent<IconProps>;
  end?: boolean;
  /** Extra routes that keep this item highlighted (they have no nav entry of their own). */
  alsoActiveOn?: string[];
  /** The headed section it sits in. Items without one are the top few, above every heading. */
  group?: NavGroup;
}

/** Settings is kept apart from the list: pinned to the bottom of the sidebar, or the right end of the bar. */
export const SETTINGS_ITEM: NavItem = { to: '/settings', label: 'Settings', icon: SettingsIcon };

/** Help sits with Settings rather than in the list, since it is about every page at once. */
export const HELP_ITEM: NavItem = { to: '/help', label: 'Help', icon: CircleQuestion };

/** The entries kept out of the list and pinned at its end, in the order they are shown. */
export const PINNED_ITEMS: readonly NavItem[] = [HELP_ITEM, SETTINGS_ITEM];

/** Every destination, in sidebar order. The command palette lists them in this order too. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/workspace', label: 'Workspace', icon: Workspace },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  // Prompt History has no nav entry of its own; it stays under Prompt Builder.
  {
    to: '/prompt-builder',
    label: 'Prompt Builder',
    icon: Sparkles,
    alsoActiveOn: ['/prompt-history'],
    group: 'Build',
  },
  { to: '/ask-ai', label: 'Ask AI', icon: MessageSquare, group: 'Build' },
  { to: '/api-client', label: 'API Client', icon: Send, group: 'Build' },
  { to: '/studio', label: 'Studio', icon: Clapperboard, group: 'Build' },
  { to: '/cli-manager', label: 'AI CLI Manager', icon: TerminalSquare, group: 'Agents' },
  { to: '/skills', label: 'Skills', icon: Blocks, group: 'Agents' },
  { to: '/mcp', label: 'MCP Servers', icon: Plug, group: 'Agents' },
  { to: '/tools', label: 'Agent Tools', icon: Wrench, group: 'Agents' },
  { to: '/usage', label: 'Token Usage', icon: ChartColumn, group: 'Agents' },
  { to: '/pipelines', label: 'Pipelines', icon: Github, group: 'Ship' },
  { to: '/deploy', label: 'Deploy', icon: Rocket, group: 'Ship' },
  { to: '/monitoring', label: 'Monitoring', icon: HeartPulse, group: 'Ship' },
  { to: '/docker', label: 'Docker', icon: Docker, group: 'Ship' },
  { to: '/android', label: 'Android', icon: Android, group: 'Ship' },
  { to: '/remote', label: 'Remote', icon: Monitor, group: 'Connect' },
  { to: '/vault', label: 'Vault', icon: Vault, group: 'Connect' },
  HELP_ITEM,
  SETTINGS_ITEM,
];

/**
 * Whether `item` is the page being shown. Same rule as NavLink (a prefix match on whole path
 * segments, exact when `end` is set), plus the routes it stands in for via `alsoActiveOn`.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (matchPath({ path: item.to, end: item.end ?? false }, pathname)) return true;
  return item.alsoActiveOn?.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ?? false;
}

export type WorkspaceAttention = 'needs-input' | 'done' | null;

/**
 * What the menu flags for attention: unread pipeline results, health targets with an incident
 * open, and an agent waiting in the Workspace.
 */
export function useNavBadges(): {
  unread: number;
  workspaceAttention: WorkspaceAttention;
  healthIncidents: number;
} {
  const queryClient = useQueryClient();
  const unreadQuery = useQuery({
    queryKey: queryKeys.appNotificationUnread,
    queryFn: () => window.runova.appNotifications.unreadCount(),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    return window.runova.appNotifications.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.appNotificationUnread });
      void queryClient.invalidateQueries({ queryKey: queryKeys.appNotifications });
    });
  }, [queryClient]);

  // The same list the Monitoring page reads, so the badge and the page never disagree.
  const healthQuery = useQuery({
    queryKey: queryKeys.healthList(),
    queryFn: async () => (await window.runova.health.list()) ?? [],
    meta: { silentLoading: true },
  });

  useEffect(() => {
    return window.runova.health.onChanged(() => {
      void queryClient.invalidateQueries(
        { queryKey: queryKeys.healthList() },
        { cancelRefetch: false },
      );
    });
  }, [queryClient]);

  const workspaceAttention = useAgentStatusStore((s): WorkspaceAttention => {
    const all = Object.values(s.statuses);
    return all.includes('needs-input') ? 'needs-input' : all.includes('done') ? 'done' : null;
  });

  return {
    unread: unreadQuery.data ?? 0,
    workspaceAttention,
    healthIncidents: openIncidentCount(healthQuery.data),
  };
}

/** The company behind the app, spelled the way the LICENSE and splash spell it. */
export const PUBLISHER = 'SmartClouds';

/**
 * The version and update state behind the menu's about card, the top bar's version chip and the
 * About dialog they open, plus the update check the dialog runs.
 */
export function useUpdateCheck(): {
  /** The about button's accessible name: "Runova v1.2.3, by SmartClouds, about". */
  label: string;
  /** The about button's hover hint. */
  tooltip: string;
  /** Just "v1.2.3" (or "dev"), empty until the version is known. */
  versionText: string;
  checking: boolean;
  /** A newer version was found and is waiting, downloading or ready to install. */
  updatePending: boolean;
  checkForUpdates: () => Promise<void>;
} {
  const appVersionQuery = useQuery({
    queryKey: queryKeys.appVersion,
    queryFn: () => window.runova.app.getVersion(),
  });
  const checking = useUpdateStore((s) => s.status.state === 'checking');
  const updatePending = useUpdateStore((s) => PENDING_STATES.has(s.status.state));

  /**
   * A check that finds something hands off to UpdateManager's dialog; the quiet
   * outcomes (already current, or the check itself failed) only get a toast.
   */
  async function checkForUpdates(): Promise<void> {
    if (checking) return;
    const result = await window.runova.app.checkForUpdates();
    if (result.state === 'not-available') toast.success("You're on the latest version.");
    else if (result.state === 'error') toast.error(result.message);
    else openUpdateDialog();
  }

  const version = appVersionQuery.data;
  const versionText = version == null ? '' : version === 'dev' ? 'dev' : `v${version}`;
  // The name starts with the product and version so a screen reader says those first, then any
  // update news, and ends with where the button goes.
  const name = versionText ? `Runova ${versionText}` : 'Runova';
  const status = checking ? 'checking for updates, ' : updatePending ? 'update available, ' : '';
  return {
    label: `${name}, by ${PUBLISHER}, ${status}about`,
    tooltip: updatePending ? 'About Runova. An update is available' : 'About Runova',
    versionText,
    checking,
    updatePending,
    checkForUpdates,
  };
}

/** Update states that mean a newer version exists, whatever stage its download is at. */
const PENDING_STATES = new Set<UpdateStatus['state']>([
  'available',
  'downloading',
  'paused',
  'downloaded',
]);
