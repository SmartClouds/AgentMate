import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { NavLink, useLocation } from 'react-router-dom';
// The styles module alone, so the always-loaded menu does not pull the whole kit in with it.
import { SECTION_HEADING } from '@/components/pageKit/styles';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';
import { AboutCard } from './AboutCard';
import {
  isNavItemActive,
  NAV_GROUPS,
  NAV_ITEMS,
  type NavItem,
  PINNED_ITEMS,
  useNavBadges,
} from './mainNav';

// The menu's entries live in mainNav.ts, shared with the top menu bar. Re-exported here so the
// pages that list them (the command palette, Settings) keep importing from the sidebar.
export { NAV_GROUPS, NAV_ITEMS };

export function Sidebar(): React.JSX.Element {
  const sidebarMode = useUiStore((s) => s.sidebarMode);
  const collapsed = sidebarMode === 'collapsed';
  const hidden = sidebarMode === 'hidden';
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();
  const { unread, workspaceAttention, healthIncidents } = useNavBadges();

  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  return (
    <aside
      className={cn(
        'sidebar-gradient flex shrink-0 flex-col overflow-hidden py-3 transition-[width] duration-200',
        hidden ? 'w-0 px-0' : cn('sidebar-panel mb-1.5 ml-2 px-2.5', collapsed ? 'w-16' : 'w-56'),
      )}
      aria-hidden={hidden}
    >
      {!hidden && (
        <LayoutGroup>
          <nav className="rail-scroll flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overflow-x-hidden">
            {NAV_ITEMS.filter((item) => !item.group && !PINNED_ITEMS.includes(item)).map(
              renderItem,
            )}
            {NAV_GROUPS.map((group) => (
              <div key={group} role="group" aria-label={group} className="flex flex-col gap-px">
                {collapsed ? (
                  <div className="mx-3 my-1.5 h-px shrink-0 bg-border/60" />
                ) : (
                  <div className={cn(SECTION_HEADING, 'px-3 pb-1 pt-3')}>{group}</div>
                )}
                {NAV_ITEMS.filter((item) => item.group === group).map(renderItem)}
              </div>
            ))}
          </nav>

          <div className="mt-1.5 flex shrink-0 flex-col gap-px border-t border-border/50 pt-1.5">
            {PINNED_ITEMS.map(renderItem)}
            <AboutCard collapsed={collapsed} />
          </div>
        </LayoutGroup>
      )}
    </aside>
  );

  function renderItem(item: NavItem): React.JSX.Element {
    // isNavItemActive applies the same match NavLink does, plus the extra routes an entry stays
    // lit on, so it is the one source for the active look.
    const active = isNavItemActive(item, pathname);

    // className and children are plain values, not NavLink's render functions. On the icon rail
    // the link is the tooltip's asChild trigger, and Radix Slot joins className as a string, which
    // would turn a function into its own source text and drop the real classes.
    const link = (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        className={cn(
          'group relative flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-[5px] text-sm font-medium transition-colors',
          // The nav scrolls with overflow hidden, which clips an outline drawn outside the entry,
          // so keyboard focus gets a ring drawn inside its edge instead.
          'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          // On the icon rail each entry is a centred square, so the active pill and the hover
          // background are squares too. 34px keeps all the entries on screen in a short window.
          collapsed && 'mx-auto h-8.5 w-8.5 justify-center p-0',
          active
            ? 'font-semibold text-primary'
            : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
        )}
      >
        {active && (
          <motion.span
            layoutId="sidebar-active"
            className="absolute inset-0 rounded-lg bg-primary/12"
            transition={pillTransition}
          />
        )}
        {active && !collapsed && (
          <span className="absolute left-0 top-1/2 z-10 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />
        )}
        <item.icon className={cn('relative z-10 h-4 w-4 shrink-0', active && 'text-primary')} />
        {!collapsed && <span className="relative z-10">{item.label}</span>}
        {item.to === '/pipelines' && unread > 0 ? (
          collapsed ? (
            <span className="absolute right-1 top-1 z-10 h-1.5 w-1.5 rounded-full bg-destructive" />
          ) : (
            <span className="relative z-10 ml-auto rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold leading-none text-destructive-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          )
        ) : null}
        {item.to === '/monitoring' && healthIncidents > 0 ? (
          collapsed ? (
            <span className="absolute right-1 top-1 z-10 h-1.5 w-1.5 rounded-full bg-destructive" />
          ) : (
            <span className="relative z-10 ml-auto rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold leading-none text-destructive-foreground">
              {healthIncidents > 99 ? '99+' : healthIncidents}
            </span>
          )
        ) : null}
        {item.to === '/monitoring' && healthIncidents > 0 ? (
          <span className="sr-only">
            , {healthIncidents} open incident{healthIncidents === 1 ? '' : 's'}
          </span>
        ) : null}
        {item.to === '/workspace' && workspaceAttention ? (
          <span
            className={cn(
              'z-10 h-1.5 w-1.5 rounded-full',
              collapsed ? 'absolute right-1 top-1' : 'relative ml-auto',
              workspaceAttention === 'needs-input'
                ? 'bg-warning shadow-[0_0_6px_hsl(var(--warning))]'
                : 'bg-primary shadow-[0_0_6px_hsl(var(--primary))]',
            )}
          />
        ) : null}
      </NavLink>
    );

    return collapsed ? (
      <SimpleTooltip key={item.to} label={item.label} side="right">
        {link}
      </SimpleTooltip>
    ) : (
      link
    );
  }
}
