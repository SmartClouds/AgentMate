import { AI_TRANSITIONS, type EditOp, type Scene, toDuration } from '@agentmat/studio';
import { useEffect, useId, useState } from 'react';
import { fieldSecondsToFlicks, flicksToFieldSeconds, scriptClass } from '../format';
import {
  ArrowDown,
  ArrowUp,
  Button,
  Combobox,
  cn,
  GLASS_CARD,
  Input,
  Label,
  SimpleTooltip,
  Textarea,
  Trash2,
} from '../kit';

const TRANSITION_LABELS: Record<(typeof AI_TRANSITIONS)[number], string> = {
  cut: 'Cut',
  fade: 'Fade',
  fadeblack: 'Fade through black',
  fadewhite: 'Fade through white',
  dissolve: 'Dissolve',
  wipeleft: 'Wipe left',
  wiperight: 'Wipe right',
  slideleft: 'Slide left',
  slideright: 'Slide right',
  circleopen: 'Circle open',
};

const TRANSITION_OPTIONS = AI_TRANSITIONS.map((value) => ({
  value,
  label: TRANSITION_LABELS[value],
}));

/** On-screen text is edited as one line per caption; blank lines are dropped. */
function toLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export interface SceneCardProps {
  scene: Scene;
  index: number;
  count: number;
  /** The video's frame rate, which a transition's length lands on. */
  fps: number;
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
  onRemove: (scene: Scene, index: number) => void;
  /** The scene's motion graphics: preview, animate with AI, code. */
  motion?: React.ReactNode;
}

/**
 * One scene of the scenario, edited in place. A field saves when it loses focus, as one history
 * entry named after what changed, so the History panel reads like a list of real edits.
 */
export function SceneCard({
  scene,
  index,
  count,
  fps,
  apply,
  onRemove,
  motion,
}: SceneCardProps): React.JSX.Element {
  const id = useId();
  const number = index + 1;
  const [title, setTitle] = useState(scene.title);
  const [narration, setNarration] = useState(scene.narration);
  const [duration, setDuration] = useState(flicksToFieldSeconds(scene.targetDuration));
  const [onScreen, setOnScreen] = useState(scene.onScreenText.join('\n'));
  const [visual, setVisual] = useState(scene.visualBrief);
  const durationFlicks = fieldSecondsToFlicks(duration);

  // A change from elsewhere (undo, restore, an AI edit) replaces what the fields show.
  useEffect(() => setTitle(scene.title), [scene.title]);
  useEffect(() => setNarration(scene.narration), [scene.narration]);
  useEffect(() => setDuration(flicksToFieldSeconds(scene.targetDuration)), [scene.targetDuration]);
  const onScreenText = scene.onScreenText.join('\n');
  useEffect(() => setOnScreen(onScreenText), [onScreenText]);
  useEffect(() => setVisual(scene.visualBrief), [scene.visualBrief]);
  const transition = scene.transitionOut?.kind ?? 'cut';

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
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-onscreen`}>On screen</Label>
          <Textarea
            id={`${id}-onscreen`}
            value={onScreen}
            dir="auto"
            rows={2}
            className={scriptClass(onScreen)}
            placeholder="Short lines shown on screen, one per line"
            onChange={(event) => setOnScreen(event.target.value)}
            onBlur={() => {
              const lines = toLines(onScreen);
              if (lines.join('\n') !== onScreenText) {
                void update(
                  { onScreenText: lines },
                  `Edited the on-screen text of scene ${number}`,
                );
              }
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-visual`}>What the viewer sees</Label>
          <Textarea
            id={`${id}-visual`}
            value={visual}
            dir="auto"
            rows={2}
            className={scriptClass(visual)}
            placeholder="Layout, objects and motion, for the animation"
            onChange={(event) => setVisual(event.target.value)}
            onBlur={() => {
              if (visual !== scene.visualBrief) {
                void update({ visualBrief: visual }, `Edited what scene ${number} shows`);
              }
            }}
          />
        </div>
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
        {index < count - 1 && (
          <div className="space-y-1.5">
            <Label>Then</Label>
            <Combobox
              ariaLabel={`How scene ${number} hands over`}
              className="w-48"
              options={TRANSITION_OPTIONS}
              value={transition}
              onChange={(next) => {
                if (next === transition) return;
                const transitionOut =
                  next === 'cut'
                    ? null
                    : { kind: next as Exclude<typeof next, 'cut'>, duration: toDuration(0.5, fps) };
                void update(
                  { transitionOut } as Partial<Omit<Scene, 'id'>>,
                  `Changed how scene ${number} hands over`,
                );
              }}
            />
          </div>
        )}
        {durationFlicks === null && (
          <p id={`${id}-duration-error`} className="pb-2 text-xs text-destructive">
            Enter a length from 0.5 to 600 seconds.
          </p>
        )}
      </div>
      {motion}
    </section>
  );
}
