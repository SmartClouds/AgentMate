import type { RootCheckView } from '@runova/studio';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { studioClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
  Chip,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Folder,
  GLASS_CARD,
  Notice,
  SECTION_HEADING,
  Skeleton,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { StorageLocationField } from './StorageLocationField';

/**
 * Where a project's videos are kept. It is always outside the project's source, so videos never
 * end up in the repository or in front of an agent working on the code.
 */
export function ProjectStorageCard({ projectId }: { projectId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const storage = useQuery({
    queryKey: studioKeys.projectStorage(projectId),
    queryFn: () => studioClient().projectStorage(projectId),
  });
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState('');
  const [check, setCheck] = useState<RootCheckView | null>(null);
  const onCheck = useCallback((value: RootCheckView | null) => setCheck(value), []);

  const save = useMutation({
    mutationFn: (next: string | null) => studioClient().setProjectRoot(projectId, next),
    onSuccess: (view) => {
      queryClient.setQueryData(studioKeys.projectStorage(projectId), view);
      setEditing(false);
      toast.success(
        view.isCustom
          ? 'New videos for this project go to the new folder.'
          : 'Back to the default folder.',
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const data = storage.data;
  const problem = data?.check.problems.find((p) => p.level === 'error');

  return (
    <section className={cn(GLASS_CARD, 'space-y-2 p-3')} aria-label="Video folder">
      <div className="flex items-center gap-2">
        <Folder className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className={SECTION_HEADING}>Video folder</h3>
        {data && (
          <Chip tone={data.isCustom ? 'primary' : 'neutral'}>
            {data.isCustom ? 'Chosen' : 'Default'}
          </Chip>
        )}
      </div>
      {storage.isLoading && <Skeleton className="h-5 w-2/3" />}
      {storage.error && (
        <Notice tone="destructive" size="sm">
          {errorMessage(storage.error)}
        </Notice>
      )}
      {data && (
        <>
          <p className="break-all font-mono text-xs">{data.root}</p>
          <p className="text-xs text-muted-foreground">
            New videos for this project are saved here, outside the project's source folder.
          </p>
          {problem && (
            <Notice tone="destructive" size="sm">
              {problem.message}
            </Notice>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPath(data.root);
                setEditing(true);
              }}
            >
              Change folder
            </Button>
            {data.isCustom && (
              <Button
                size="sm"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => save.mutate(null)}
              >
                Use the default
              </Button>
            )}
          </div>
        </>
      )}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Video folder for this project</DialogTitle>
            <DialogDescription>
              Videos already made stay where they are; move one from its menu in the Studio library.
            </DialogDescription>
          </DialogHeader>
          <StorageLocationField
            label="Folder"
            value={path}
            onChange={setPath}
            projectId={projectId}
            onCheck={onCheck}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              disabled={!check?.ok || save.isPending}
              onClick={() => save.mutate(path.trim())}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
