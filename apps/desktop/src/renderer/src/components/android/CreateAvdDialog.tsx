import {
  avdIdFromDisplayName,
  describeSystemImage,
  isValidAvdName,
  type SystemImage,
} from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { InstallSystemImage } from './InstallSystemImage';

/**
 * Creating a virtual device.
 *
 * Two things here are worth the extra code. The name is validated as it is typed and the id it
 * will actually be saved under is shown underneath, because avdmanager rejects spaces and Studio
 * does not, so "Pixel 7 test" silently becoming Pixel_7_test is a surprise worth heading off.
 * And when no system images are installed the step offers the ones that can be downloaded and
 * installs the chosen one from here, rather than printing a command to run somewhere else.
 */

/** Where to get the package that is missing, since the SDK Manager route is the usual one. */
const CMDLINE_TOOLS_URL = 'https://developer.android.com/studio#command-line-tools-only';

interface CreateAvdDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names already in use, so a duplicate is caught without a round trip. */
  existingNames: string[];
  onCreated: (name: string) => void;
  /** Which SDK tools are present. Creating an AVD needs avdmanager and nothing else will do. */
  tools: { avdmanager: boolean; sdkmanager: boolean };
}

/**
 * An SDK installed by Android Studio does not ship the command-line tools by default, so this is
 * a common first visit rather than an edge case. It gets the same treatment as a missing SDK:
 * say what is needed, where it comes from, and leave no dead control behind.
 */
function MissingToolsBody(): React.JSX.Element {
  return (
    <div className="glass space-y-3 rounded-xl p-4">
      <p className="text-sm">
        Creating a virtual device needs <span className="font-mono">avdmanager</span>, which comes
        with the Android SDK Command-line Tools. This SDK does not have them yet.
      </p>
      <p className="text-xs text-muted-foreground">
        In Android Studio: Settings, Languages &amp; Frameworks, Android SDK, then the SDK Tools
        tab, and tick "Android SDK Command-line Tools". Everything else on this page keeps working
        without them.
      </p>
    </div>
  );
}

function nameProblem(typed: string, id: string, existing: string[]): string | null {
  if (typed.trim() === '') return 'Give it a name.';
  if (!isValidAvdName(id)) return 'Use letters, digits, dots, dashes and underscores.';
  if (existing.includes(id)) return `There is already a virtual device called ${id}.`;
  return null;
}

export function CreateAvdDialog({
  open,
  onOpenChange,
  existingNames,
  onCreated,
  tools,
}: CreateAvdDialogProps): React.JSX.Element {
  const canCreate = tools.avdmanager;
  const queryClient = useQueryClient();
  const [typedName, setTypedName] = useState('');
  const [profile, setProfile] = useState('');
  const [imageId, setImageId] = useState('');

  const imagesQuery = useQuery({
    queryKey: queryKeys.androidSystemImages,
    queryFn: () => window.runova.android.listSystemImages(),
    enabled: open && canCreate,
    meta: { silentLoading: true },
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.androidDeviceProfiles,
    queryFn: () => window.runova.android.listDeviceProfiles(),
    enabled: open && canCreate,
    meta: { silentLoading: true },
  });

  const images: SystemImage[] = imagesQuery.data ?? [];
  const profiles = profilesQuery.data ?? [];

  // Default to the newest image and a sensible phone, so the common case is one click.
  useEffect(() => {
    if (!imageId && images.length > 0) setImageId(images[0].id);
  }, [images, imageId]);
  useEffect(() => {
    if (!profile && profiles.length > 0)
      setProfile(profiles.includes('pixel_7') ? 'pixel_7' : profiles[0]);
  }, [profiles, profile]);

  const id = avdIdFromDisplayName(typedName);
  const problem = nameProblem(typedName, id, existingNames);
  const noImages = !imagesQuery.isLoading && images.length === 0;

  const create = useMutation({
    mutationFn: () =>
      window.runova.android.createAvd({ name: id, systemImageId: imageId, device: profile }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message ?? 'Could not create that virtual device.');
        return;
      }
      toast.success(`${id} created.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.androidSnapshot });
      onCreated(id);
      onOpenChange(false);
      setTypedName('');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const imageOptions = useMemo(
    () =>
      images.map((image) => ({
        value: image.id,
        label: describeSystemImage(image),
        // So typing "34", "playstore" or "x86" all find the right one.
        keywords: [image.id, String(image.api ?? ''), image.tag, image.abi],
      })),
    [images],
  );

  const chosenImage = images.find((image) => image.id === imageId);
  const blocked = problem !== null || imageId === '' || create.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New virtual device</DialogTitle>
          <DialogDescription>
            {canCreate
              ? 'Pick the hardware to emulate and the version of Android to run on it.'
              : 'This needs one SDK package that is not installed yet.'}
          </DialogDescription>
        </DialogHeader>

        {!canCreate && <MissingToolsBody />}

        {canCreate && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="avd-name">Name</Label>
              <Input
                id="avd-name"
                value={typedName}
                placeholder="Pixel 7 API 34"
                onChange={(event) => setTypedName(event.target.value)}
              />
              {problem ? (
                <p className="text-xs text-destructive">{problem}</p>
              ) : id !== typedName.trim() ? (
                // Studio allows spaces, avdmanager does not, so say what it will really be called.
                <p className="text-xs text-muted-foreground">
                  Saved as <span className="font-mono">{id}</span>
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label>Device</Label>
              <Combobox
                options={profiles.map((name) => ({ value: name, label: name }))}
                value={profile}
                onChange={setProfile}
                placeholder="Pick a device profile"
                searchPlaceholder="Search devices"
              />
            </div>

            <div className="space-y-1.5">
              <Label>System image</Label>
              {imagesQuery.isLoading ? (
                // An empty Combobox says "No results found", which reads as "there is nothing to
                // install" rather than "the list has not arrived yet".
                <div className="glass flex items-center gap-2 rounded-xl p-3">
                  <Skeleton className="h-4 w-4 rounded-full" />
                  <p className="text-xs text-muted-foreground">Reading the installed images…</p>
                </div>
              ) : noImages ? (
                <InstallSystemImage onInstalled={() => void imagesQuery.refetch()} />
              ) : (
                <Combobox
                  options={imageOptions}
                  value={imageId}
                  onChange={setImageId}
                  placeholder="Pick a system image"
                  searchPlaceholder="Search by API level or ABI"
                />
              )}
            </div>

            {chosenImage && profile && (
              <p className="text-xs text-muted-foreground">
                {profile} · {describeSystemImage(chosenImage)}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {canCreate ? 'Cancel' : 'Close'}
          </Button>
          {canCreate ? (
            <Button disabled={blocked} onClick={() => create.mutate()}>
              {create.isPending ? 'Creating' : 'Create'}
            </Button>
          ) : (
            <Button onClick={() => void window.runova.shell.openExternal(CMDLINE_TOOLS_URL)}>
              <ExternalLink className="h-3.5 w-3.5" />
              How to install
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
