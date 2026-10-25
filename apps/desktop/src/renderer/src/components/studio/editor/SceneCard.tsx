import type { EditOp, Scene } from '@agentmat/studio';
import { useEffect, useId, useState } from 'react';
import { fieldSecondsToFlicks, flicksToFieldSeconds, scriptClass } from '../format';
import {
  ArrowDown,
  ArrowUp,
  Button,
  cn,
  GLASS_CARD,
  Input,
  Label,
  SimpleTooltip,
  Textarea,
  Trash2,
} from '../kit';

export interface SceneCardProps {
  scene: Scene;
  index: number;
  count: number;
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
  onRemove: (scene: Scene, index: number) => void;
}

/**
 * One scene of the scenario, edited in place. A field saves when it loses focus, as one history
 * entry named after what changed, so the History panel reads like a list of real edits.
 */
export function SceneCard({
  scene,
  index,
  count,
  apply,
  onRemove,
}: SceneCardProps): React.JSX.Element {
  const id = useId();
  const number = index + 1;
  const [title, setTitle] = useState(scene.title);
  const [narration, setNarration] = useState(scene.narration);
  const [duration, setDuration] = useState(flicksToFieldSeconds(scene.targetDuration));
  const durationFlicks = fieldSecondsToFlicks(duration);

  // A change from elsewhere (undo, restore, an AI edit) replaces what the fields show.
  useEffect(() => setTitle(scene.title), [scene.title]);
  useEffect(() => setNarration(scene.narration), [scene.narration]);
  useEffect(() => setDuration(flicksToFieldSeconds(scene.targetDuration)), [scene.targetDuration]);

  const update = (patch: Partial<Omit<Scene, 'id'>>, label: string) =>
    apply([{ op: 'scene.update', sceneId: scene.id, patch }], label);

  return (
    <section className={cn(GLASS_CARD, 'space-y-3 p-3')} aria-label={`Scene ${number}`}>
      <div className="flex items-center gap-2">
        <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-foreground/[0.06] px-2 text-xs font-semibold tabular-nums">
          {number}
        </span>
        <Input
          aria-label={`Scene ${number} title`}
          value={title}
          dir="auto"
          placeholder="Scene title"
          className={cn('h-8 flex-1 font-medium', scriptClass(title))}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            if (title !== scene.title) void update({ title }, `Renamed scene ${number}`);
          }}
        />
        <SimpleTooltip label="Move up">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move scene ${number} up`}
            disabled={index === 0}
            onClick={() =>
              void apply(
                [{ op: 'scene.move', sceneId: scene.id, index: index - 1 }],
                `Moved scene ${number} up`,
              )
            }
          >
            <ArrowUp />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Move down">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move scene ${number} down`}
            disabled={index === count - 1}
            onClick={() =>
              void apply(
                [{ op: 'scene.move', sceneId: scene.id, index: index + 1 }],
                `Moved scene ${number} down`,
              )
            }
          >
            <ArrowDown />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Delete scene">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete scene ${number}`}
            onClick={() => onRemove(scene, index)}
          >
            <Trash2 />
          </Button>
        </SimpleTooltip>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-narration`}>Narration</Label>
        <Textarea
          id={`${id}-narration`}
          value={narration}
          dir="auto"
          className={scriptClass(narration)}
          rows={3}
          placeholder="What the voice-over says in this scene"
          onChange={(event) => setNarration(event.target.value)}
          onBlur={() => {
            if (narration !== scene.narration)
              void update({ narration }, `Edited the narration of scene ${number}`);
          }}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-duration`}>Length (seconds)</Label>
          <Input
            id={`${id}-duration`}
            inputMode="decimal"
            value={duration}
            aria-invalid={durationFlicks === null}
            aria-describedby={durationFlicks === null ? `${id}-duration-error` : undefined}
            className="h-8 w-24 tabular-nums"
            onChange={(event) => setDuration(event.target.value)}
            onBlur={() => {
              if (durationFlicks === null) return;
              if (durationFlicks !== scene.targetDuration) {
                void update(
                  { targetDuration: durationFlicks },
                  `Changed the length of scene ${number}`,
                );
              }
            }}
          />
        </div>
        {durationFlicks === null && (
          <p id={`${id}-duration-error`} className="pb-2 text-xs text-destructive">
            Enter a length from 0.5 to 600 seconds.
          </p>
        )}
      </div>
    </section>
  );
}
