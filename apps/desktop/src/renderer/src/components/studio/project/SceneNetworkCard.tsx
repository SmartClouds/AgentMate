import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { studioClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
  Chip,
  cn,
  GLASS_CARD,
  Label,
  Notice,
  SECTION_HEADING,
  Skeleton,
  Textarea,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';

/**
 * The hosts this project's scenes may load from. Scene code is written by AI and runs with no
 * network at all by default; a project that needs, say, its own CDN names it here, over https.
 */
export function SceneNetworkCard({ projectId }: { projectId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const id = useId();
  const storage = useQuery({
    queryKey: studioKeys.projectStorage(projectId),
    queryFn: () => studioClient().projectStorage(projectId),
  });
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const hosts = storage.data?.sceneHosts ?? [];

  const save = useMutation({
    mutationFn: (next: string[]) => studioClient().setSceneHosts(projectId, next),
    onSuccess: (view) => {
      queryClient.setQueryData(studioKeys.projectStorage(projectId), view);
      setEditing(false);
      toast.success(
        view.sceneHosts.length
          ? 'Scenes in this project may load from those hosts.'
          : 'Scenes in this project reach no network.',
      );
    },
  });

  return (
    <section className={cn(GLASS_CARD, 'space-y-2 p-3')} aria-label="Scene network">
      <div className="flex items-center gap-2">
        <h3 className={SECTION_HEADING}>Scene network</h3>
        {!editing && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={storage.isPending}
            onClick={() => {
              setText(hosts.join('\n'));
              setEditing(true);
            }}
          >
            Change
          </Button>
        )}
      </div>
      {storage.isPending && <Skeleton className="h-6 w-2/3" />}
      {!editing && storage.data && (
        <p className="flex flex-wrap items-center gap-1.5 text-sm">
          {hosts.length === 0 ? (
            <span className="text-muted-foreground">
              None. Animated scenes cannot reach the internet.
            </span>
          ) : (
            hosts.map((host) => (
              <Chip key={host} tone="warning">
                {host}
              </Chip>
            ))
          )}
        </p>
      )}
      {editing && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              text
                .split(/[\s,]+/)
                .map((h) => h.trim())
                .filter(Boolean),
            );
          }}
        >
          <Label htmlFor={`${id}-hosts`}>Hosts scenes may load from, one per line</Label>
          <Textarea
            id={`${id}-hosts`}
            value={text}
            rows={3}
            dir="ltr"
            placeholder="cdn.example.com"
            onChange={(event) => setText(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Only https, and only these hosts. Leave it empty to keep scenes offline, which is
            safest: the code is written by AI.
          </p>
          {save.error && (
            <Notice tone="destructive" size="sm">
              {errorMessage(save.error)}
            </Notice>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? 'Saving...' : 'Save'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
