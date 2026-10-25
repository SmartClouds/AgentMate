import type { RootCheckView, StudioSettingsPatch } from '@agentmat/studio';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useState } from 'react';
import { studioClient } from '../client';
import { errorMessage } from '../format';
import { Button, Input, Label, Skeleton, Switch, toast } from '../kit';
import { studioKeys } from '../queryKeys';
import { StorageLocationField } from '../storage/StorageLocationField';

/** Studio's settings: the library folder, the working cache and render defaults. */
export function StudioSettingsSection(): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: studioKeys.settings,
    queryFn: () => studioClient().settings(),
  });
  const [root, setRoot] = useState('');
  const [check, setCheck] = useState<RootCheckView | null>(null);
  const [cap, setCap] = useState('');
  const onCheck = useCallback((value: RootCheckView | null) => setCheck(value), []);

  useEffect(() => {
    if (!settings.data) return;
    setRoot(settings.data.defaultRoot);
    setCap(String(settings.data.cacheCapGb));
  }, [settings.data]);

  const update = useMutation({
    mutationFn: (patch: StudioSettingsPatch) => studioClient().updateSettings(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(studioKeys.settings, next);
      void queryClient.invalidateQueries({ queryKey: studioKeys.all });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (!settings.data) return <Skeleton className="h-40 w-full" />;
  const data = settings.data;
  const capNumber = Number(cap);
  const capValid = Number.isInteger(capNumber) && capNumber >= 1 && capNumber <= 2000;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <StorageLocationField
          label="Studio library folder"
          description="Standalone videos are made here, and each project gets a folder inside it unless you choose another one in the project's Studio tab."
          value={root}
          onChange={setRoot}
          projectId={null}
          onCheck={onCheck}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={root.trim() === data.defaultRoot || !check?.ok || update.isPending}
            onClick={() => update.mutate({ defaultRoot: root.trim() })}
          >
            Save folder
          </Button>
          {data.defaultRootIsCustom && (
            <Button size="sm" variant="ghost" onClick={() => update.mutate({ defaultRoot: null })}>
              Use the default
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-cap`}>Working files limit (GB)</Label>
        <p className="text-xs text-muted-foreground">
          Previews and render pieces are kept in {data.cacheDir}, on this computer, never in a
          synced folder. The oldest are cleared past this size. Your videos and their history are
          never cleared.
        </p>
        <div className="flex items-center gap-2">
          <Input
            id={`${id}-cap`}
            inputMode="numeric"
            className="h-8 w-24 tabular-nums"
            value={cap}
            aria-invalid={!capValid}
            onChange={(event) => setCap(event.target.value)}
            onBlur={() => {
              if (capValid && capNumber !== data.cacheCapGb)
                update.mutate({ cacheCapGb: capNumber });
            }}
          />
          {!capValid && (
            <span className="text-xs text-destructive">Enter a whole number from 1 to 2000.</span>
          )}
        </div>
      </div>

      <label className="flex items-start justify-between gap-4" htmlFor={`${id}-resume`}>
        <span>
          <span className="block text-sm font-medium">Resume renders after a restart</span>
          <span className="block text-xs text-muted-foreground">
            A render that was cut off by a crash or a restart carries on from where it stopped.
          </span>
        </span>
        <Switch
          id={`${id}-resume`}
          checked={data.autoResumeRenders}
          onCheckedChange={(checked) => update.mutate({ autoResumeRenders: checked })}
        />
      </label>

      <label className="flex items-start justify-between gap-4" htmlFor={`${id}-hw`}>
        <span>
          <span className="block text-sm font-medium">Use the graphics card to encode</span>
          <span className="block text-xs text-muted-foreground">
            Faster renders on NVIDIA, Intel and Apple hardware. Studio checks it works first and
            falls back if not.
          </span>
        </span>
        <Switch
          id={`${id}-hw`}
          checked={data.hwEncode}
          onCheckedChange={(checked) => update.mutate({ hwEncode: checked })}
        />
      </label>
    </div>
  );
}
