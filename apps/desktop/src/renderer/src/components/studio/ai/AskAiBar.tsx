import { useState } from 'react';
import { scriptClass } from '../format';
import {
  Button,
  ChevronDown,
  cn,
  GLASS_CARD,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  type RunSettings,
  RunSettingsFields,
  Send,
  Sparkles,
} from '../kit';
import { runLabel } from './runSettings';

export interface AskAiBarProps {
  run: RunSettings;
  onRunChange: (run: RunSettings) => void;
  /** An AI run is already working on the video. */
  busy: boolean;
  /** Resolves to true once the request is on its way, which clears the field. */
  onAsk: (instruction: string) => Promise<boolean>;
}

/** Edit by typing: say what to change, and the AI proposes the edit for the user to approve. */
export function AskAiBar({ run, onRunChange, busy, onAsk }: AskAiBarProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ready = text.trim().length > 0 && !busy && !sending;

  const submit = async () => {
    if (!ready) return;
    setSending(true);
    try {
      if (await onAsk(text.trim())) setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 p-2')}
      aria-label="Ask AI"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Sparkles className="ml-1 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <Input
        aria-label="What should change"
        value={text}
        dir="auto"
        maxLength={20_000}
        className={cn('h-8 min-w-[12rem] flex-1', scriptClass(text))}
        placeholder="Ask AI to change the scenario: a shorter opening, a scene about pricing, a warmer tone..."
        onChange={(event) => setText(event.target.value)}
      />
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" size="sm" variant="ghost" className="max-w-[16rem]">
            <span className="truncate">{runLabel(run)}</span>
            <ChevronDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[26rem] max-w-[calc(100vw-2rem)] space-y-2 p-3">
          <p className="text-xs text-muted-foreground">Which AI makes the change</p>
          <RunSettingsFields value={run} onChange={onRunChange} />
        </PopoverContent>
      </Popover>
      <Button type="submit" size="sm" disabled={!ready}>
        <Send /> {busy ? 'AI is busy' : 'Ask'}
      </Button>
    </form>
  );
}
