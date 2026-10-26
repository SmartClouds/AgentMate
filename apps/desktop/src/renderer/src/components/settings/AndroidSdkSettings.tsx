import type { AppSettings } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Android, CircleCheck, CircleX, FolderOpen } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The Android SDK override. Detection covers almost everyone, so this card leads with what was
 * found and where it came from, and only then offers to replace it. Clearing goes back to
 * detection rather than to an empty path.
 */

const SOURCE_LABEL: Record<string, string> = {
  override: 'set here',
  ANDROID_HOME: 'from ANDROID_HOME',
  ANDROID_SDK_ROOT: 'from ANDROID_SDK_ROOT',
  default: 'found in the usual install folder',
};

export function AndroidSdkSettings({ settings }: { settings: AppSettings }): React.JSX.Element {
  const queryClient = useQueryClient();

  const sdkQuery = useQuery({
    queryKey: queryKeys.androidSdk,
    queryFn: () => window.runova.android.sdk(),
    meta: { silentLoading: true },
  });

  const setSdkPath = useMutation({
    mutationFn: (path: string | null) => window.runova.android.setSdkPath(path),
    onSuccess: (sdk) => {
      queryClient.setQueryData(queryKeys.androidSdk, sdk);
      toast.success(sdk.status === 'found' ? 'Android SDK found.' : 'Saved.');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveSetting = useMutation({
    mutationFn: (updates: Partial<AppSettings>) => window.runova.settings.update(updates),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  const browse = async (): Promise<void> => {
    const picked = await window.runova.android.pickSdkPath();
    if (picked) setSdkPath.mutate(picked);
  };

  const sdk = sdkQuery.data;
  const found = sdk?.status === 'found';
  const overridden = Boolean(settings.androidSdkPath);

  return (
    <Card className="glass">
      <CardHeader className="flex-row items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Android className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <CardTitle>Android SDK</CardTitle>
          <CardDescription>
            Where the Android page looks for adb, the emulator and the command-line tools.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="glass flex flex-wrap items-center gap-3 rounded-xl p-3">
          {found ? (
            <CircleCheck className="h-4 w-4 shrink-0 text-success" />
          ) : (
            <CircleX className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            {found && sdk?.root ? (
              <>
                <p className="break-all font-mono text-xs">{sdk.root}</p>
                <p className="text-xs text-muted-foreground">
                  {SOURCE_LABEL[sdk.source ?? 'default']}
                  {sdk.adbVersion ? ` · platform-tools ${sdk.adbVersion}` : ''}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No Android SDK found. Pick the folder that holds platform-tools and emulator.
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="soft" disabled={setSdkPath.isPending} onClick={() => void browse()}>
              <FolderOpen className="h-3.5 w-3.5" />
              Browse
            </Button>
            {overridden && (
              <Button
                variant="soft"
                disabled={setSdkPath.isPending}
                onClick={() => setSdkPath.mutate(null)}
              >
                Clear
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="android-stop-on-quit">Stop emulators when Runova quits</Label>
            <p className="text-xs text-muted-foreground">
              Off by default. An emulator is a window you can close yourself, and it takes a while
              to boot again.
            </p>
          </div>
          <Switch
            id="android-stop-on-quit"
            checked={settings.androidStopEmulatorsOnQuit === true}
            onCheckedChange={(checked) =>
              saveSetting.mutate({ androidStopEmulatorsOnQuit: checked })
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}
