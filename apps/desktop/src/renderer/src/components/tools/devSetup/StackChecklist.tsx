import type { ChecklistGroup, ChecklistRow } from '@runova/core';
import { Chip, SectionCard } from '@/components/pageKit';
import { DevItemRow } from './DevItemRow';
import type { RowAction, RowView } from './devSetupView';
import { STACK_ICONS } from './stackIcons';

/** One stack's tools as a card: its name and progress, then a row for each tool. */
export function StackChecklist({
  group,
  viewOf,
  onAction,
  onTerminal,
  onCopy,
  onShowLog,
}: {
  group: ChecklistGroup;
  viewOf: (row: ChecklistRow) => RowView;
  onAction: (row: ChecklistRow, view: RowView, action: RowAction) => void;
  onTerminal: (row: ChecklistRow, view: RowView) => void;
  onCopy: (row: ChecklistRow, view: RowView) => void;
  onShowLog?: (row: ChecklistRow) => void;
}): React.JSX.Element {
  const Icon = STACK_ICONS[group.stack.id];
  const complete = group.total > 0 && group.ready === group.total;

  return (
    <SectionCard
      aria-label={group.stack.name}
      headingLevel={2}
      icon={<Icon />}
      title={group.stack.name}
      description={group.stack.description}
      extra={
        <div className="flex items-center gap-1.5">
          {group.updates > 0 && (
            <Chip tone="primary">
              {group.updates} {group.updates === 1 ? 'update' : 'updates'}
            </Chip>
          )}
          <Chip tone={complete ? 'success' : 'neutral'}>
            {group.ready} of {group.total} ready
          </Chip>
        </div>
      }
      flush
    >
      <ul
        aria-label={`${group.stack.name} tools`}
        className="pb-1 [&>li+li]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]"
      >
        {group.rows.map((row) => {
          const view = viewOf(row);
          return (
            <DevItemRow
              key={row.item.id}
              row={row}
              view={view}
              onAction={(action) => onAction(row, view, action)}
              onTerminal={() => onTerminal(row, view)}
              onCopy={() => onCopy(row, view)}
              onShowLog={onShowLog ? () => onShowLog(row) : undefined}
            />
          );
        })}
      </ul>
    </SectionCard>
  );
}
