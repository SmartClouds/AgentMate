import { createScene, type EditOp, newId, type Scene, type StudioDocument } from '@agentmat/studio';
import { useEffect, useId, useState } from 'react';
import { scriptClass } from '../format';
import {
  Button,
  cn,
  confirmDialog,
  EmptyState,
  GLASS_CARD,
  Label,
  Pencil,
  Plus,
  Textarea,
} from '../kit';
import { SceneCard } from './SceneCard';

export interface ScenarioPanelProps {
  document: StudioDocument;
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
  /** The AI brief card, shown above the scenario. */
  brief?: React.ReactNode;
}

/** The scenario, scene by scene: written by AI from the brief, or by hand, and edited either way. */
export function ScenarioPanel({ document, apply, brief }: ScenarioPanelProps): React.JSX.Element {
  const id = useId();
  const scenes = document.scenario.scenes;
  const [logline, setLogline] = useState(document.scenario.logline);
  useEffect(() => setLogline(document.scenario.logline), [document.scenario.logline]);

  const addScene = () =>
    apply(
      [{ op: 'scene.add', scene: createScene({ id: newId(), title: '' }), index: scenes.length }],
      `Added scene ${scenes.length + 1}`,
    );

  async function remove(scene: Scene, index: number) {
    const ok = await confirmDialog({
      title: `Delete scene ${index + 1}?`,
      description: 'You can bring it back with Undo or from the History panel.',
      confirmLabel: 'Delete scene',
      variant: 'destructive',
    });
    if (ok) await apply([{ op: 'scene.remove', sceneId: scene.id }], `Deleted scene ${index + 1}`);
  }

  return (
    <div className="space-y-2">
      {brief}
      <div className={cn(GLASS_CARD, 'space-y-1.5 p-3')}>
        <Label htmlFor={`${id}-logline`}>What the video is about</Label>
        <Textarea
          id={`${id}-logline`}
          value={logline}
          dir="auto"
          className={scriptClass(logline)}
          rows={2}
          placeholder="One or two sentences: the story, who it is for, and what they should feel or do."
          onChange={(event) => setLogline(event.target.value)}
          onBlur={() => {
            if (logline !== document.scenario.logline) {
              void apply(
                [{ op: 'scenario.set', patch: { logline } }],
                'Edited what the video is about',
              );
            }
          }}
        />
      </div>
      {scenes.length === 0 ? (
        <EmptyState
          card
          size="sm"
          icon={Pencil}
          title="No scenes yet"
          description={
            brief
              ? 'Write the brief above and let the AI write them, or add the first scene yourself.'
              : 'Add the first scene and write what it shows and says.'
          }
          action={
            <Button onClick={() => void addScene()}>
              <Plus /> Add scene
            </Button>
          }
        />
      ) : (
        <>
          {scenes.map((scene, index) => (
            <SceneCard
              key={scene.id}
              scene={scene}
              index={index}
              count={scenes.length}
              fps={document.renderSettings.fps}
              apply={apply}
              onRemove={(s, i) => void remove(s, i)}
            />
          ))}
          <Button variant="outline" onClick={() => void addScene()}>
            <Plus /> Add scene
          </Button>
        </>
      )}
    </div>
  );
}
