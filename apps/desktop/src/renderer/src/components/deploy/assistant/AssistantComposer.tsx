import { CLI_REGISTRY } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CliLogo } from '@/components/cliLogos';
import { Send, StopCircle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Where the user says what the AI should do (E09 T8), and with which AI: the provider set in
 * Settings by default, or an installed agent CLI. While a run goes, the button stops it; once it
 * is over, the same box asks a follow-up on the same server and context.
 */

/** Picker value for the OpenAI, Gemini or Ollama provider set in Settings. */
export const SETTINGS_PROVIDER = '__settings__';

export function AssistantComposer({
  running,
  finished,
  initialPrompt,
  disabled,
  onStart,
  onStop,
}: {
  running: boolean;
  /** A run ended, so the next task is a follow-up. */
  finished: boolean;
  initialPrompt: string;
  disabled?: boolean;
  onStart: (prompt: string, cliId: string | null) => Promise<boolean>;
  onStop: () => void;
}): React.JSX.Element {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [ai, setAi] = useState(SETTINGS_PROVIDER);
  const [starting, setStarting] = useState(false);
  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    meta: { silentLoading: true },
  });
  const promptClis = CLI_REGISTRY.filter(
    (cli) => cli.promptCommand && cliQuery.data?.find((c) => c.id === cli.id)?.installed,
  );

  async function start(): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed || starting) return;
    setStarting(true);
    try {
      if (await onStart(trimmed, ai === SETTINGS_PROVIDER ? null : ai)) setPrompt('');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="deploy-assistant-task" className="text-xs">
        {finished ? 'Ask a follow-up' : 'What should the AI look into?'}
      </Label>
      <Textarea
        id="deploy-assistant-task"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="e.g. Find out why the sender keeps restarting"
        className="min-h-20 resize-none text-sm"
        disabled={running || disabled}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void start();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Combobox
          className="h-8 min-w-0 flex-1 text-xs"
          value={ai}
          onChange={setAi}
          disabled={running || disabled}
          placeholder="AI"
          searchPlaceholder="Search…"
          ariaLabel="Which AI"
          options={[
            { value: SETTINGS_PROVIDER, label: 'AI provider (Settings)' },
            ...promptClis.map((cli) => ({
              value: cli.id,
              label: cli.name,
              icon: <CliLogo cliId={cli.id} className="h-3.5 w-3.5 shrink-0" />,
            })),
          ]}
        />
        {running ? (
          <Button variant="danger" onClick={onStop}>
            <StopCircle /> Stop
          </Button>
        ) : (
          <Button onClick={() => void start()} disabled={!prompt.trim() || starting || disabled}>
            <Send /> {finished ? 'Ask' : 'Start'}
          </Button>
        )}
      </div>
    </div>
  );
}
