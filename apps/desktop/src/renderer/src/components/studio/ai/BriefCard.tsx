import type { Aspect } from '@agentmat/studio';
import { useState } from 'react';
import { Button, ChevronDown, cn, GLASS_CARD, Sparkles } from '../kit';
import { BriefFields, type BriefValue } from './BriefFields';
import { type ScenarioRequest, toRunInput } from './runSettings';

export interface BriefCardProps {
  aspect: Aspect;
  language: string;
  /** The video already has scenes, so this rewrites them; folded until the user opens it. */
  rewriting: boolean;
  /** An AI run is working on the video. */
  busy: boolean;
  initial: BriefValue;
  /** Resolves to true once the run has started. */
  onStart: (request: ScenarioRequest, value: BriefValue) => Promise<boolean>;
}

/** The brief step: the user says what the video is about, and the AI writes the scenario. */
export function BriefCard({
  aspect,
  language,
  rewriting,
  busy,
  initial,
  onStart,
}: BriefCardProps): React.JSX.Element {
  const [open, setOpen] = useState(!rewriting);
  const [value, setValue] = useState<BriefValue>(initial);
  const [starting, setStarting] = useState(false);
  const ready = value.brief.trim().length > 0 && !busy && !starting;

  if (!open) {
    return (
      <Button variant="outline" className="w-full justify-start" onClick={() => setOpen(true)}>
        <Sparkles /> Rewrite the scenario with AI
        <ChevronDown className="ml-auto" />
      </Button>
    );
  }

  const submit = async () => {
    if (!ready) return;
    setStarting(true);
    try {
      const started = await onStart(
        {
          brief: value.brief.trim(),
          targetSeconds: value.targetSeconds,
          styleId: value.styleId,
          run: toRunInput(value.run),
        },
        value,
      );
      if (started && rewriting) setOpen(false);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className={cn(GLASS_CARD, 'space-y-3 p-3')} aria-label="Write with AI">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">
          {rewriting ? 'Rewrite the scenario with AI' : 'Write the scenario with AI'}
        </h2>
        {rewriting && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setOpen(false)}>
            Close
          </Button>
        )}
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <BriefFields
          value={value}
          onChange={setValue}
          aspect={aspect}
          language={language}
          autoFocus={!rewriting}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!ready}>
            <Sparkles /> {busy ? 'AI is busy' : rewriting ? 'Rewrite scenario' : 'Write scenario'}
          </Button>
          <span className="text-xs text-muted-foreground">
            {rewriting
              ? 'The current scenes are replaced in one step, so Undo brings them back.'
              : 'You can edit every scene afterwards, by hand or by asking AI.'}
          </span>
        </div>
      </form>
    </section>
  );
}
