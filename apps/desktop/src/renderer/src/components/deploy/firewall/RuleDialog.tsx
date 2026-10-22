import {
  FIREWALL_ACTIONS,
  FIREWALL_PROTOCOLS,
  type RuleDraft,
  ruleFromDraft,
} from '@shared/deploy/firewallValidation';
import type { FirewallRuleSpec } from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ACTION_HINT, ACTION_LABEL, PROTOCOL_LABEL } from '@/lib/deploy/firewall/format';

/**
 * Adds a rule, or edits one (which the core does as removing the old rule and adding the new
 * one in the same change set). Ports take a single port or a range; the source takes an address
 * or a network in CIDR form, checked as it is typed. Nothing reaches the server from here: the
 * rule joins the staged changes, which are previewed before anything is applied.
 */

export function RuleDialog({
  open,
  initial,
  editing,
  sourceHint,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  initial: RuleDraft;
  editing: boolean;
  /** Shown under the source for presets best kept to a network (databases). */
  sourceHint?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (rule: FirewallRuleSpec) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setTouched(false);
    }
  }, [open, initial]);

  const checked = ruleFromDraft(draft);
  const set = (fields: Partial<RuleDraft>) => setDraft((current) => ({ ...current, ...fields }));

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    setTouched(true);
    if (!checked.ok) return;
    onSave(checked.value);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit rule' : 'Add a rule'}</DialogTitle>
            <DialogDescription>
              The rule is staged with your other changes. You see the exact commands before anything
              changes on the server.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rule-action">Action</Label>
              <Combobox
                id="rule-action"
                searchable={false}
                options={FIREWALL_ACTIONS.map((action) => ({
                  value: action,
                  label: ACTION_LABEL[action],
                }))}
                value={draft.action}
                onChange={(action) => set({ action: action as RuleDraft['action'] })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-protocol">Protocol</Label>
              <Combobox
                id="rule-protocol"
                searchable={false}
                options={FIREWALL_PROTOCOLS.map((protocol) => ({
                  value: protocol,
                  label: PROTOCOL_LABEL[protocol],
                }))}
                value={draft.protocol}
                onChange={(protocol) => set({ protocol: protocol as RuleDraft['protocol'] })}
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{ACTION_HINT[draft.action]}</p>
          <div className="space-y-1.5">
            <Label htmlFor="rule-ports">Ports</Label>
            <Input
              id="rule-ports"
              value={draft.ports}
              onChange={(event) => set({ ports: event.target.value })}
              placeholder="8080, or a range such as 6000-6007"
              className="font-mono"
              inputMode="numeric"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-source">Source</Label>
            <Input
              id="rule-source"
              value={draft.source}
              onChange={(event) => set({ source: event.target.value })}
              placeholder="Anywhere, or 203.0.113.7, or 10.0.0.0/8"
              className="font-mono"
            />
            {sourceHint && <p className="text-xs text-muted-foreground">{sourceHint}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-comment">Comment</Label>
            <Input
              id="rule-comment"
              value={draft.comment}
              onChange={(event) => set({ comment: event.target.value })}
              placeholder="What it is for"
            />
          </div>
          {touched && !checked.ok && (
            <p role="alert" className="text-sm text-destructive">
              {checked.reason}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{editing ? 'Stage the edit' : 'Stage the rule'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
