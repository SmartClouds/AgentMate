import type {
  FirewallPreset,
  FirewallRuleInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Check, Plus, Sparkles } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { CARD_ROWS, RowsSkeleton, SecurityCard } from '../security/SecurityCard';

/**
 * Ready-made rules: SSH on the ports sshd really uses, HTTP, HTTPS and the common databases.
 * A preset whose ports are already allowed from anywhere says so. A database preset opens the
 * rule form first, so it can be kept to a network rather than the whole internet.
 */

function covered(preset: FirewallPreset, rules: FirewallRuleInfo[]): boolean {
  return preset.rules.every((spec) =>
    rules.some(
      (rule) =>
        rule.action === spec.action &&
        !rule.source &&
        rule.port === spec.port &&
        (rule.portTo ?? rule.port) === (spec.portTo ?? spec.port) &&
        (rule.protocol === spec.protocol || rule.protocol === 'any'),
    ),
  );
}

export function PresetsCard({
  presets,
  rules,
  loading,
  canEdit,
  onPick,
}: {
  presets: FirewallPreset[] | undefined;
  rules: FirewallRuleInfo[];
  loading: boolean;
  canEdit: boolean;
  onPick: (preset: FirewallPreset) => void;
}): React.JSX.Element {
  return (
    <SecurityCard
      icon={<Sparkles />}
      title="Presets"
      description="Common rules, staged with one click."
    >
      {loading && !presets ? (
        <RowsSkeleton rows={2} />
      ) : (
        <ul className={CARD_ROWS}>
          {(presets ?? []).map((preset) => {
            const already = covered(preset, rules);
            return (
              <li
                key={preset.id}
                aria-label={preset.name}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{preset.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{preset.description}</p>
                </div>
                {already ? (
                  <Chip tone="success">
                    <Check /> Open
                  </Chip>
                ) : (
                  canEdit && (
                    <Button
                      size="sm"
                      variant="soft"
                      aria-label={`Stage the ${preset.name} preset`}
                      onClick={() => onPick(preset)}
                    >
                      <Plus className="h-3.5 w-3.5" /> Stage
                    </Button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SecurityCard>
  );
}
