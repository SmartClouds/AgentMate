import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown } from '@/components/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { openAbout } from '@/stores/aboutStore';
import { UpdateDot, VERSION_CHIP, VersionChipLabel } from './AboutCard';
import {
  HELP_ITEM,
  isNavItemActive,
  NAV_GROUPS,
  NAV_ITEMS,
  type NavGroup,
  type NavItem,
  PINNED_ITEMS,
  SETTINGS_ITEM,
  useNavBadges,
  useUpdateCheck,
  type WorkspaceAttention,
} from './mainNav';

/** The shape every entry on the bar shares: a rounded pill, like a segmented toggle. */
const PILL =
  'relative flex h-7 shrink-0 [-webkit-app-region:no-drag] select-none items-center gap-1.5 rounded-full px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60';
const PILL_IDLE = 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground';
const PILL_ACTIVE = 'font-semibold text-primary';

/**
 * The main menu as a bar along the top of the window, for people who would rather give the page
 * the full width than keep a sidebar. Same destinations as the sidebar (see mainNav.ts): the few
 * ungrouped pages are tabs, each sidebar heading becomes a dropdown, and Settings sits at the end.
 */
export function TopMenu(): React.JSX.Element {
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();
  const { unread, workspaceAttention, healthIncidents } = useNavBadges();
  const updateCheck = useUpdateCheck();

  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  /** The highlight behind the current entry. Shared across the bar so it slides between them. */
  const activePill = (
    <motion.span
      layoutId="top-menu-active"
      className="absolute inset-0 rounded-full bg-primary/12"
      transition={pillTransition}
    />
  );

  return (
    // The gaps between entries drag the window, the same as the title bar above.
    <nav
      aria-label="Main menu"
      className="mx-2 flex h-10 shrink-0 items-center gap-3 [-webkit-app-region:drag]"
    >
      <LayoutGroup>
        {/* On a narrow window the tabs scroll sideways rather than wrap onto a second row. */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {NAV_ITEMS.filter((item) => !item.group && !PINNED_ITEMS.includes(item)).map((item) => (
            <Tab
              key={item.to}
              item={item}
              active={isNavItemActive(item, pathname)}
              activePill={activePill}
              attention={item.to === '/workspace' ? workspaceAttention : null}
            />
          ))}
          {NAV_GROUPS.map((group) => (
            <GroupMenu
              key={group}
              group={group}
              pathname={pathname}
              activePill={activePill}
              unread={unread}
              healthIncidents={healthIncidents}
            />
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* The same chip as the sidebar's about card, and like the card it opens About. */}
          <SimpleTooltip label={updateCheck.tooltip} side="bottom">
            <button
              type="button"
              aria-label={updateCheck.label}
              aria-haspopup="dialog"
              aria-busy={updateCheck.checking}
              onClick={openAbout}
              className={cn(
                VERSION_CHIP,
                'relative h-6 px-2.5 text-[11px] outline-hidden transition-colors [-webkit-app-region:no-drag] hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60',
              )}
            >
              <VersionChipLabel
                versionText={updateCheck.versionText}
                checking={updateCheck.checking}
                fallback="Runova"
              />
              {updateCheck.updatePending && <UpdateDot className="absolute -right-0.5 -top-0.5" />}
            </button>
          </SimpleTooltip>
          <Tab
            item={HELP_ITEM}
            active={isNavItemActive(HELP_ITEM, pathname)}
            activePill={activePill}
            showIcon
          />
          <Tab
            item={SETTINGS_ITEM}
            active={isNavItemActive(SETTINGS_ITEM, pathname)}
            activePill={activePill}
            showIcon
          />
        </div>
      </LayoutGroup>
    </nav>
  );
}

function Tab({
  item,
  active,
  activePill,
  attention = null,
  showIcon = false,
}: {
  item: NavItem;
  active: boolean;
  activePill: React.JSX.Element;
  attention?: WorkspaceAttention;
  showIcon?: boolean;
}): React.JSX.Element {
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(PILL, active ? PILL_ACTIVE : PILL_IDLE)}
    >
      {active && activePill}
      {showIcon && <item.icon className="relative z-10 h-3.5 w-3.5 shrink-0" />}
      <span className="relative z-10">{item.label}</span>
      {attention ? (
        <>
          <span
            className={cn(
              'relative z-10 h-1.5 w-1.5 rounded-full',
              attention === 'needs-input'
                ? 'bg-warning shadow-[0_0_6px_hsl(var(--warning))]'
                : 'bg-primary shadow-[0_0_6px_hsl(var(--primary))]',
            )}
          />
          <span className="sr-only">
            {attention === 'needs-input' ? ', an agent needs your input' : ', an agent finished'}
          </span>
        </>
      ) : null}
    </Link>
  );
}

function GroupMenu({
  group,
  pathname,
  activePill,
  unread,
  healthIncidents = 0,
}: {
  group: NavGroup;
  pathname: string;
  activePill: React.JSX.Element;
  unread: number;
  /** Health targets with an incident open, shown on the Monitoring entry. */
  healthIncidents?: number;
}): React.JSX.Element {
  const items = NAV_ITEMS.filter((item) => item.group === group);
  const active = items.some((item) => isNavItemActive(item, pathname));
  // Unread pipeline results live in Ship; the trigger carries a dot so they show while it is shut.
  const groupUnread = items.some((item) => item.to === '/pipelines') ? unread : 0;
  // Open health incidents live in Ship too, and light the same dot.
  const groupIncidents = items.some((item) => item.to === '/monitoring') ? healthIncidents : 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // A trigger is a button, not a link, so it is marked as the current item of the bar.
          aria-current={active ? 'true' : undefined}
          className={cn(
            'group',
            PILL,
            'pr-2.5',
            active ? PILL_ACTIVE : cn(PILL_IDLE, 'data-[state=open]:bg-foreground/[0.06]'),
          )}
        >
          {active && activePill}
          <span className="relative z-10">{group}</span>
          <ChevronDown className="relative z-10 h-3 w-3 opacity-60 transition-transform duration-150 group-data-[state=open]:rotate-180" />
          {groupUnread > 0 || groupIncidents > 0 ? (
            <span className="absolute right-1 top-1 z-10 h-1.5 w-1.5 rounded-full bg-destructive" />
          ) : null}
          {groupUnread > 0 ? <span className="sr-only">, {groupUnread} unread</span> : null}
          {groupIncidents > 0 ? (
            <span className="sr-only">
              , {groupIncidents} open incident{groupIncidents === 1 ? '' : 's'}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-[12rem]">
        {items.map((item) => {
          const current = isNavItemActive(item, pathname);
          return (
            <DropdownMenuItem key={item.to} asChild>
              <Link
                to={item.to}
                aria-current={current ? 'page' : undefined}
                className={cn(current && 'font-semibold text-primary')}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
                {item.to === '/pipelines' && unread > 0 ? (
                  <span className="ml-auto rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold leading-none text-destructive-foreground">
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
                {item.to === '/monitoring' && healthIncidents > 0 ? (
                  <span className="ml-auto rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold leading-none text-destructive-foreground">
                    {healthIncidents > 99 ? '99+' : healthIncidents}
                    <span className="sr-only">
                      {' '}
                      open incident{healthIncidents === 1 ? '' : 's'}
                    </span>
                  </span>
                ) : null}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
