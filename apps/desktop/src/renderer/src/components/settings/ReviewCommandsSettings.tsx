import { DEFAULT_REVIEW_COMMANDS } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The PR comments offered as one-click review requests in the workspace Pull request tab, such
 * as `@claude review`. Each bot has its own wording, so the list is the user's to edit.
 */
export function ReviewCommandsSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const commands = settings.data?.reviewCommands ?? [...DEFAULT_REVIEW_COMMANDS];
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (next: string[]) => window.runova.settings.update({ reviewCommands: next }),
    meta: { silentLoading: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  function save(next: string[]): void {
    queryClient.setQueryData(queryKeys.settings, (current: typeof settings.data) =>
      current ? { ...current, reviewCommands: next } : current,
    );
    mutation.mutate(next);
  }

  function add(): void {
    const command = draft.trim();
    if (!command) return;
    if (commands.includes(command)) {
      setProblem('Already in the list.');
      return;
    }
    save([...commands, command]);
    setDraft('');
    setProblem(null);
  }

  return (
    <div className="max-w-2xl space-y-3">
      {commands.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {commands.map((command) => (
            <li
              key={command}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-border/70 bg-foreground/[0.03] pl-3 pr-1 font-mono text-xs"
            >
              {command}
              <button
                type="button"
                aria-label={`Remove ${command}`}
                onClick={() => save(commands.filter((item) => item !== command))}
                className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No review commands. Add one below.</p>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          aria-label="New review command"
          aria-invalid={problem ? true : undefined}
          placeholder="@bot review"
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
        />
        <Button onClick={add} disabled={!draft.trim()} className="gap-1">
          <Plus className="h-3 w-3" />
          Add
        </Button>
      </div>
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}

      <button
        type="button"
        onClick={() => save([...DEFAULT_REVIEW_COMMANDS])}
        className="text-xs font-medium text-primary hover:underline"
      >
        Reset to defaults
      </button>
    </div>
  );
}
