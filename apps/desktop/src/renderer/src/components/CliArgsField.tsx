import { getCliDefinition } from '@runova/core';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useCliStore } from '@/stores/cliStore';

const HINT =
  'Only for background tasks Runova runs with this CLI: commit messages, tag suggestions, version bumps, and skill audits. Terminals and Workspace tabs never use these; they take Launch defaults from Settings.';

/**
 * Extra flags for one CLI, e.g. "--model sonnet", used only when Runova runs it in the
 * background (never for terminals, which take Launch defaults). Saved on blur (and on Enter) rather
 * than per keystroke, so a half-typed flag never reaches a run.
 */
export function CliArgsField({
  cliId,
  label = 'Background task arguments',
}: {
  cliId: string;
  label?: string;
}): React.JSX.Element | null {
  const savedArgs = useCliStore((s) => s.cliArgs[cliId] ?? '');
  const setCliArgs = useCliStore((s) => s.setCliArgs);
  const [value, setValue] = useState(savedArgs);
  const [editing, setEditing] = useState(false);

  // The same CLI can be edited from CLI Manager and from Settings; pick up an edit made
  // on the other surface, but not while this input is the one being typed in.
  useEffect(() => {
    if (!editing) setValue(savedArgs);
  }, [savedArgs, editing]);

  const cli = getCliDefinition(cliId);
  if (!cli) return null;

  function commit(): void {
    setEditing(false);
    if (value.trim() !== savedArgs) setCliArgs(cliId, value);
  }

  return (
    <div className="w-full space-y-1.5">
      <SimpleTooltip label={HINT}>
        <span className="w-fit text-xs text-muted-foreground">{label}</span>
      </SimpleTooltip>
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        // Every CLI names its flags differently, so the hint comes from the registry
        // entry rather than one CLI's syntax standing in for all of them.
        placeholder={cli.argsExample ?? '--flag value'}
        className="h-8 font-mono text-xs"
        spellCheck={false}
      />
      {value.trim() && (
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {cli.executableNames[0]} {value.trim()}
        </p>
      )}
    </div>
  );
}
