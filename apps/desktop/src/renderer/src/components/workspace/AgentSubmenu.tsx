import {
  type CliLaunchDefault,
  EFFORT_LABELS,
  type LaunchPick,
  type LaunchPickModel,
  type LaunchPickOptions,
  launchPickLabel,
} from '@runova/core';
import { CostMeter } from '@/components/cli/CostMeter';
import { CliLogo } from '@/components/cliLogos';
import { Check, Play } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_CHECK_ICON } from '@/components/ui/overlay';
import type { AgentChoice } from '@/lib/workspace/agentChoices';

export interface AgentSubmenuProps {
  choice: AgentChoice;
  options: LaunchPickOptions;
  /** The CLI's launch defaults from Settings. Marks the matching rows and says what "defaults" means. */
  saved: CliLaunchDefault | undefined;
  /** The digit hint at the right edge, the same one a plain row shows. */
  trailing?: React.ReactNode;
  /** Starts the CLI. No pick means "with the launch defaults". */
  onLaunch: (pick: LaunchPick | undefined, skipLaunchDefaults: boolean) => void;
  /** Closes the whole menu, for the clicks that would otherwise only open a flyout. */
  onClose: () => void;
}

/** Lines a flyout's first row up with the row that opened it, and keeps it on screen. */
const FLYOUT = { alignOffset: -5, collisionPadding: 8 } as const;

const OWN_DEFAULT = "The CLI's own default";

/**
 * The slot at the left of a flyout row. Always there, so names line up whether or not the row
 * carries the check that marks the user's saved launch default.
 */
function SavedMark({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center"
      data-saved={on ? 'true' : undefined}
    >
      {on ? (
        <>
          <Check className={MENU_CHECK_ICON} />
          <span className="sr-only">Launch default</span>
        </>
      ) : null}
    </span>
  );
}

/** A row that starts the CLI with no model picked: a small play mark over a line of context. */
function DefaultRow({
  title,
  detail,
  ...props
}: {
  title: string;
  detail: string;
} & React.ComponentProps<typeof DropdownMenuItem>): React.JSX.Element {
  return (
    <DropdownMenuItem {...props}>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <Play className="size-2.5 text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span>{title}</span>
        <span className="truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </DropdownMenuItem>
  );
}

function ModelBody({
  model,
  saved,
}: {
  model: LaunchPickModel;
  saved: boolean;
}): React.JSX.Element {
  return (
    <>
      <SavedMark on={saved} />
      <span className="min-w-0 flex-1 truncate">{model.label}</span>
      {model.tier ? (
        // A fixed, right-aligned column, so the tags and the cost bars line up from row to row.
        <span className="w-[4.25rem] shrink-0 text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {model.tier}
        </span>
      ) : null}
      {model.costLevel ? <CostMeter level={model.costLevel} /> : null}
    </>
  );
}

/**
 * An agent row that opens a model list, and a model that opens an effort list. A plain click on
 * the row (or on a model) still starts the CLI right away, so the flyouts are the optional
 * second and third step. Enter or the right arrow opens a flyout instead, which is why each one
 * begins with a row that launches without picking.
 */
export function AgentSubmenu({
  choice,
  options,
  saved,
  trailing,
  onLaunch,
  onClose,
}: AgentSubmenuProps): React.JSX.Element {
  const cliId = choice.cli.id;

  /** Radix would take a click on a trigger as "open the flyout", so a launch has to say otherwise. */
  const launchOnClick =
    (pick: LaunchPick | undefined) =>
    (event: React.MouseEvent): void => {
      event.preventDefault();
      onClose();
      onLaunch(pick, event.altKey);
    };

  /** A plain item closes the menu itself, and Alt+click is the one case that needs the click. */
  const itemProps = (pick: LaunchPick | undefined) => ({
    onSelect: () => onLaunch(pick, false),
    onClick: (event: React.MouseEvent) => {
      if (!event.altKey) return;
      event.preventDefault();
      onClose();
      onLaunch(pick, true);
    },
  });

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger onClick={launchOnClick(undefined)}>
        <CliLogo cliId={cliId} className="h-4 w-4" />
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="truncate">{choice.cli.name}</span>
          {choice.isDefault ? (
            <Chip tone="primary" className="h-4 px-1.5 text-[10px]">
              Default
            </Chip>
          ) : null}
        </span>
        {trailing}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[16rem]" {...FLYOUT}>
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <DefaultRow
          title="Launch with defaults"
          detail={launchPickLabel(cliId, saved ?? {}) ?? OWN_DEFAULT}
          {...itemProps(undefined)}
        />
        <DropdownMenuSeparator />
        {options.models.map((model) => {
          const isSaved = saved?.model === model.value;
          const efforts = model.efforts ?? [];
          if (efforts.length === 0) {
            return (
              <DropdownMenuItem key={model.value} {...itemProps({ model: model.value })}>
                <ModelBody model={model} saved={isSaved} />
              </DropdownMenuItem>
            );
          }
          const savedEffort =
            saved?.effort && efforts.includes(saved.effort) ? saved.effort : undefined;
          return (
            <DropdownMenuSub key={model.value}>
              <DropdownMenuSubTrigger onClick={launchOnClick({ model: model.value })}>
                <ModelBody model={model} saved={isSaved} />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[12rem]" {...FLYOUT}>
                <DropdownMenuLabel>Effort for {model.label}</DropdownMenuLabel>
                <DefaultRow
                  title="Default effort"
                  detail={savedEffort ? `Your setting: ${EFFORT_LABELS[savedEffort]}` : OWN_DEFAULT}
                  {...itemProps({ model: model.value })}
                />
                <DropdownMenuSeparator />
                {efforts.map((effort) => {
                  const cost = model.effortCost?.[effort];
                  return (
                    <DropdownMenuItem key={effort} {...itemProps({ model: model.value, effort })}>
                      <SavedMark on={saved?.effort === effort} />
                      <span className="min-w-0 flex-1">{EFFORT_LABELS[effort]}</span>
                      {cost ? <CostMeter level={cost} /> : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
