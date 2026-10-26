import { CLI_REGISTRY, type CliDefinition } from '@runova/core';

export interface AgentChoice {
  cli: CliDefinition;
  installed: boolean;
  isDefault: boolean;
}

/**
 * Registry CLIs in the user's chosen order. Ids the order doesn't mention (a CLI added in a
 * later release) keep their registry position after the ordered ones.
 */
export function orderedClis(order: readonly string[]): CliDefinition[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return CLI_REGISTRY.map((cli, index) => ({ cli, index }))
    .sort(
      (a, b) =>
        (rank.get(a.cli.id) ?? order.length + a.index) -
        (rank.get(b.cli.id) ?? order.length + b.index),
    )
    .map(({ cli }) => cli);
}

/**
 * The agents split by whether they are on this machine, in the order the "+" menu lists them.
 * The keyboard launch (Ctrl+1 for the first) reads the same list, so the numbers always agree.
 */
export function sortAgentChoices(
  statuses: readonly { id: string; installed: boolean }[],
  cliOrder: readonly string[],
  defaultId: string | null,
): { installed: AgentChoice[]; missing: AgentChoice[] } {
  const installedIds = new Set(statuses.filter((c) => c.installed).map((c) => c.id));
  const choices = orderedClis(cliOrder).map((cli) => ({
    cli,
    installed: installedIds.has(cli.id),
    isDefault: cli.id === defaultId,
  }));
  // With no order of their own, the project's agent leads; a chosen order is kept as is.
  const byDefault = (a: AgentChoice, b: AgentChoice): number =>
    cliOrder.length > 0 ? 0 : Number(b.isDefault) - Number(a.isDefault);
  return {
    installed: choices.filter((c) => c.installed).sort(byDefault),
    missing: choices.filter((c) => !c.installed).sort(byDefault),
  };
}
