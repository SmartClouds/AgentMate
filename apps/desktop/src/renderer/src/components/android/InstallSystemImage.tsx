import { describeSystemImage, type SystemImage } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Getting a system image when none is installed.
 *
 * This replaces what used to be a command to copy into a terminal somewhere else. Downloading it
 * from here is the whole point, so the list comes from `sdkmanager --list` and the install runs
 * in the app with its progress on screen.
 *
 * The licence is accepted by the person, not by us. sdkmanager stops and asks, and the main
 * process only answers yes because this checkbox was ticked first.
 */

const LICENSE_URL = 'https://developer.android.com/studio/terms';

interface InstallSystemImageProps {
  /** Refetches the installed list, which is what the form above picks from. */
  onInstalled: () => void;
}

export function InstallSystemImage({ onInstalled }: InstallSystemImageProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ percent: number | null; label: string } | null>(null);

  const availableQuery = useQuery({
    queryKey: queryKeys.androidAvailableImages,
    queryFn: () => window.runova.android.availableSystemImages(),
    meta: { silentLoading: true },
  });
  const available = availableQuery.data?.images ?? [];
  /** What the SDK said when it could not answer, which beats guessing at the cause here. */
  const listError = availableQuery.data?.error ?? null;

  /**
   * A retry asks with the force flag, which is what makes the main process look again instead of
   * handing back what it cached. Deliberately not `refetch()`: that reuses the query function as
   * it was when the query was made, so a flag flipped just beforehand would not be in it yet.
   */
  const retry = useMutation({
    mutationFn: () => window.runova.android.availableSystemImages(true),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.androidAvailableImages, data),
  });

  // Default to the newest, which is what most people want and saves a click.
  useEffect(() => {
    if (!choice && available.length > 0) setChoice(available[0].id);
  }, [available, choice]);

  // The download reports through the shared event channel, keyed by the package being installed.
  useEffect(() => {
    return window.runova.android.onEvent((event) => {
      if (event.kind !== 'task' || !event.id.startsWith('install:')) return;
      setProgress(event.done ? null : { percent: event.progress, label: event.label });
    });
  }, []);

  const install = useMutation({
    mutationFn: () => window.runova.android.installSystemImage(choice),
    onMutate: () => {
      setError(null);
      setProgress({ percent: 0, label: 'Starting' });
    },
    onSuccess: (result) => {
      setProgress(null);
      if (!result.ok) {
        setError(result.message ?? 'The download failed.');
        return;
      }
      // The available list is this component's own; the installed one belongs to the form above,
      // so it refetches that itself. Doing both here would shell out to sdkmanager twice.
      void queryClient.invalidateQueries({ queryKey: queryKeys.androidAvailableImages });
      onInstalled();
    },
    onError: (failure: Error) => {
      setProgress(null);
      setError(failure.message);
    },
  });

  const options = available.map((image: SystemImage) => ({
    value: image.id,
    label: describeSystemImage(image),
    // So typing "35", "playstore" or "x86" all find the right one.
    keywords: [image.id, String(image.api ?? ''), image.tag, image.abi],
  }));

  if (availableQuery.isLoading) {
    return (
      <div className="glass space-y-3 rounded-xl p-3">
        <p className="text-sm">No system images are installed.</p>
        <p className="text-xs text-muted-foreground">Asking Android which ones are available…</p>
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
    );
  }

  if (available.length === 0) {
    return (
      <div className="glass space-y-3 rounded-xl p-3">
        <p className="text-sm">No system images are installed.</p>
        {listError ? (
          <>
            <p className="text-xs text-muted-foreground">
              Runova asked the SDK for the list of images and got this back:
            </p>
            <p className="break-words font-mono text-xs text-destructive">{listError}</p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            The SDK answered but did not offer any images to install. You can install one from
            Android Studio's SDK Manager instead.
          </p>
        )}
        <Button
          variant="soft"
          size="sm"
          className="w-full"
          disabled={retry.isPending}
          aria-busy={retry.isPending}
          onClick={() => retry.mutate()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${retry.isPending ? 'animate-spin' : ''}`} />
          {retry.isPending ? 'Asking again' : 'Try again'}
        </Button>
      </div>
    );
  }

  const downloading = install.isPending;

  return (
    <div className="glass space-y-3 rounded-xl p-3">
      <p className="text-sm">No system images are installed.</p>
      <p className="text-xs text-muted-foreground">
        Pick a version of Android to download. They are a few hundred megabytes each.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="install-image">Image to download</Label>
        <Combobox
          options={options}
          value={choice}
          onChange={setChoice}
          disabled={downloading}
          placeholder="Pick a system image"
          searchPlaceholder="Search by API level or ABI"
        />
        {/* The Combobox is a button, so this gives the label something real to point at. */}
        <input
          id="install-image"
          type="hidden"
          aria-label="Image to download"
          readOnly
          value={choice}
        />
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          id="accept-sdk-license"
          checked={accepted}
          disabled={downloading}
          onCheckedChange={(next) => setAccepted(next === true)}
        />
        <Label htmlFor="accept-sdk-license" className="text-xs font-normal leading-snug">
          I accept the Android SDK licence terms
        </Label>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 shrink-0 px-2 text-xs"
          onClick={() => void window.runova.shell.openExternal(LICENSE_URL)}
        >
          <ExternalLink className="h-3 w-3" />
          Read
        </Button>
      </div>

      {progress ? (
        <div className="space-y-1.5">
          <div
            className="h-[3px] overflow-hidden rounded-full bg-foreground/10"
            role="progressbar"
            aria-label="Installing the system image"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent ?? undefined}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${progress.percent ?? 0}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">{progress.label}</p>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <Button
        size="sm"
        className="w-full"
        disabled={!accepted || choice === '' || downloading}
        onClick={() => install.mutate()}
      >
        <Download className="h-3.5 w-3.5" />
        {downloading ? 'Downloading' : 'Download and install'}
      </Button>
    </div>
  );
}
