import type { FirewallRuleInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import {
  CircleCheck,
  CircleX,
  ListOrdered,
  Lock,
  Pencil,
  Plus,
  Trash2,
  Undo,
} from '@/components/icons';
import { Chip, EmptyState, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { ACTION_LABEL, PROTOCOL_LABEL, portsText, sourceText } from '@/lib/deploy/firewall/format';
import { cn } from '@/lib/utils';
import {
  CARD_BODY,
  RowsSkeleton,
  SecurityCard,
  TABLE_CELL,
  TABLE_HEAD,
} from '../security/SecurityCard';

/**
 * The rules as the backend has them, in order. Each action shows a mark and its word. Admins
 * edit and remove the rules the app can manage; others (added by hand, firewalld services the
 * app does not edit) say why they are read only. A rule staged for removal stays in the list,
 * struck through, until the change is applied or the removal is taken back.
 */

const FAMILY: Record<FirewallRuleInfo['families'], string> = {
  both: 'IPv4 and IPv6',
  ipv4: 'IPv4',
  ipv6: 'IPv6',
};

function ActionMark({ action }: { action: FirewallRuleInfo['action'] }) {
  const allows = action === 'allow' || action === 'limit';
  const Icon = allows ? CircleCheck : CircleX;
  return (
    <Chip tone={allows ? 'success' : 'destructive'}>
      <Icon />
      {ACTION_LABEL[action]}
    </Chip>
  );
}

export function RulesCard({
  rules,
  loading,
  canEdit,
  removing,
  onAdd,
  onEdit,
  onRemove,
  onKeep,
}: {
  rules: FirewallRuleInfo[] | undefined;
  loading: boolean;
  /** Admins, while no change waits for its confirmation. */
  canEdit: boolean;
  /** Rule ids staged for removal (an edit removes the old rule too). */
  removing: ReadonlySet<string>;
  onAdd: () => void;
  onEdit: (rule: FirewallRuleInfo) => void;
  onRemove: (rule: FirewallRuleInfo) => void;
  onKeep: (rule: FirewallRuleInfo) => void;
}): React.JSX.Element {
  const incoming = (rules ?? []).filter((rule) => !rule.outgoing);
  const outgoing = (rules ?? []).filter((rule) => rule.outgoing);
  return (
    <SecurityCard
      icon={<ListOrdered />}
      title="Rules"
      description="The first rule that matches decides, top to bottom."
      actions={
        canEdit && (
          <Button size="sm" variant="soft" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" /> Add rule
          </Button>
        )
      }
    >
      {loading && !rules ? (
        <RowsSkeleton />
      ) : incoming.length === 0 && outgoing.length === 0 ? (
        <div className={CARD_BODY}>
          <EmptyState
            size="sm"
            icon={ListOrdered}
            title="No rules yet."
            description="Add one, or start from a preset below."
          />
        </div>
      ) : (
        <div className={cn(FOOTER_HAIRLINE, 'overflow-x-auto')}>
          {/* The hairlines come from .settings-rows; the collapsed model is what paints them. */}
          <table className="settings-rows w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className={TABLE_HEAD}>
                  Action
                </th>
                <th scope="col" className={TABLE_HEAD}>
                  Ports
                </th>
                <th scope="col" className={TABLE_HEAD}>
                  Protocol
                </th>
                <th scope="col" className={TABLE_HEAD}>
                  Source
                </th>
                <th scope="col" className={TABLE_HEAD}>
                  Comment
                </th>
                <th scope="col" className={TABLE_HEAD}>
                  <span className="sr-only">Changes</span>
                </th>
              </tr>
            </thead>
            <tbody className="settings-rows">
              {[...incoming, ...outgoing].map((rule) => {
                const gone = removing.has(rule.id);
                return (
                  <tr
                    key={rule.id}
                    aria-label={`Rule ${portsText(rule)} ${sourceText(rule)}`}
                    className={cn(
                      'transition-colors hover:bg-foreground/[0.03]',
                      gone && 'opacity-60',
                    )}
                  >
                    <td className={cn(TABLE_CELL, gone && 'line-through')}>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <ActionMark action={rule.action} />
                        {rule.outgoing && (
                          <span className="text-xs text-muted-foreground">(outgoing)</span>
                        )}
                      </span>
                    </td>
                    <td className={cn(TABLE_CELL, 'font-mono tabular-nums')}>
                      {rule.service ? `${rule.service} service` : portsText(rule)}
                    </td>
                    <td className={TABLE_CELL}>{PROTOCOL_LABEL[rule.protocol]}</td>
                    <td className={TABLE_CELL}>
                      <SimpleTooltip label={FAMILY[rule.families]}>
                        <span
                          className="rounded-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          tabIndex={0}
                        >
                          {sourceText(rule)}
                        </span>
                      </SimpleTooltip>
                    </td>
                    <td className={cn(TABLE_CELL, 'max-w-48 truncate text-muted-foreground')}>
                      {gone ? 'Will be removed' : (rule.comment ?? rule.description)}
                    </td>
                    <td className={cn(TABLE_CELL, 'whitespace-nowrap py-1.5 text-right')}>
                      {canEdit && gone && (
                        <Button size="sm" variant="soft" onClick={() => onKeep(rule)}>
                          <Undo className="h-3.5 w-3.5" /> Keep
                        </Button>
                      )}
                      {canEdit && !gone && rule.editable && (
                        <span className="inline-flex items-center gap-0.5">
                          <SimpleTooltip label="Edit this rule">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Edit the rule for ${portsText(rule)}`}
                              onClick={() => onEdit(rule)}
                            >
                              <Pencil />
                            </Button>
                          </SimpleTooltip>
                          <SimpleTooltip label="Remove this rule">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Remove the rule for ${portsText(rule)}`}
                              onClick={() => onRemove(rule)}
                            >
                              <Trash2 />
                            </Button>
                          </SimpleTooltip>
                        </span>
                      )}
                      {!rule.editable && (
                        <SimpleTooltip
                          label={rule.note ?? 'The app does not edit this rule.'}
                          className="max-w-64"
                        >
                          <Chip
                            tabIndex={0}
                            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Lock /> Read only
                          </Chip>
                        </SimpleTooltip>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SecurityCard>
  );
}
