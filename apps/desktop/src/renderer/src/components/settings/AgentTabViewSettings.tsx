import type { AgentTabMode, AppSettings } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, TerminalSquare } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

const OPTIONS: { value: AgentTabMode; label: string; hint: string; icon: typeof MessageSquare }[] =
  [
    {
      value: 'cli',
      label: 'CLI',
      hint: 'The agent in its own terminal, exactly as it looks anywhere else.',
      icon: TerminalSquare,
    },
    {
      value: 'chat',
      label: 'Chat',
      hint: 'A chat styled after each CLI, with dictation and translation in the message box.',
      icon: MessageSquare,
    },
  ];

/**
 * Whether a Workspace agent tab opens as its CLI or as a chat. Each tab can still be switched from
 * its right-click menu, and a tab switched that way keeps its own choice.
 */
export function AgentTabViewSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  // Open tabs read the same query, so the saved answer goes straight into the cache.
  const mutation = useMutation({
    mutationFn: (defaultAgentTabMode: AgentTabMode) =>
      window.runova.settings.update({ defaultAgentTabMode }),
    meta: { silentLoading: true },
    onSuccess: (next: AppSettings) => {
      queryClient.setQueryData(queryKeys.settings, next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
  const current: AgentTabMode = mutation.isPending
    ? mutation.variables
    : (settings.data?.defaultAgentTabMode ?? 'cli');

  return (
    <div
      role="group"
      aria-label="Default view for agent tabs"
      className="grid max-w-xl grid-cols-2 gap-2"
    >
      {OPTIONS.map((option) => {
        const active = current === option.value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) mutation.mutate(option.value);
            }}
            className={cn(
              'flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-all duration-150',
              active
                ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/40'
                : 'border-border bg-background/40 hover:border-foreground/20 hover:bg-accent/40',
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              {option.label}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">{option.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
