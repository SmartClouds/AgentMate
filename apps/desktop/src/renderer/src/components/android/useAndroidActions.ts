import type { AndroidActionResult } from '@runova/core';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { showLinkedToast } from '@/lib/toastHistory';
import { confirmDialog } from '@/stores/confirmStore';
import { useTerminalStore } from '@/stores/terminalStore';

/**
 * Start, stop and cancel, with the per-device pending state the cards use to disable themselves.
 * Modelled on `components/docker/useDockerContainerActions.ts`, which does the same job for
 * containers.
 */

export interface AndroidActions {
  pending: Set<string>;
  start: (avdName: string, options?: { coldBoot?: boolean; wipeData?: boolean }) => void;
  stop: (serial: string) => void;
  cancelBoot: (avdName: string) => void;
  screenshot: (serial: string, label: string) => void;
  toggleRecording: (serial: string, label: string) => void;
  rotate: (serial: string) => void;
  openShell: (serial: string, label: string) => void;
  installApk: (serial: string, label: string, paths?: string[]) => void;
  coldBoot: (avdName: string) => void;
  wipeData: (avdName: string) => void;
  deleteAvd: (avdName: string) => void;
  /** The serial that is recording right now, or null. */
  recordingSerial: string | null;
}

export function useAndroidActions(): AndroidActions {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [recording, setRecording] = useState<{ serial: string; id: string } | null>(null);

  const run = useCallback(
    (key: string, action: () => Promise<AndroidActionResult>, failure: string) => {
      setPending((current) => new Set(current).add(key));
      void action()
        .then((result) => {
          // The main process answers with a reason rather than throwing, because "already
          // running" and "no free port" are normal outcomes, not faults.
          if (!result.ok) toast.error(result.message ?? failure);
        })
        .catch((error: Error) => toast.error(error.message || failure))
        .finally(() => {
          setPending((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.androidSnapshot });
        });
    },
    [queryClient],
  );

  /**
   * A capture is only useful if it can be found again, so this goes through the linked toast:
   * the flash offers to reveal the file, and the same entry stays in the message history with
   * the route back to this page.
   */
  const captureToast = useCallback((title: string, fileName: string, path: string) => {
    showLinkedToast(
      { kind: 'success', title, description: fileName, link: { route: '/android' } },
      () => void window.runova.android.revealCapture(path),
    );
  }, []);

  const screenshot = useCallback(
    (serial: string, label: string) => {
      void window.runova.android
        .screenshot(serial, label)
        .then((capture) => captureToast('Screenshot saved', capture.fileName, capture.path))
        .catch((error: Error) => toast.error(error.message));
    },
    [captureToast],
  );

  const toggleRecording = useCallback(
    (serial: string, label: string) => {
      if (recording?.serial === serial) {
        const { id } = recording;
        setRecording(null);
        void window.runova.android
          .stopRecording(id)
          .then((capture) => captureToast('Recording saved', capture.fileName, capture.path))
          .catch((error: Error) => toast.error(error.message));
        return;
      }
      if (recording) {
        // screenrecord is per device, but two at once is more confusion than it is worth.
        toast.error('Stop the recording that is already running first.');
        return;
      }
      void window.runova.android
        .startRecording(serial, label)
        .then(({ id }) => {
          setRecording({ serial, id });
          toast.info('Recording. It stops on its own after three minutes.');
        })
        .catch((error: Error) => toast.error(error.message));
    },
    [captureToast, recording],
  );

  const rotate = useCallback((serial: string) => {
    void window.runova.android.rotate(serial).catch((error: Error) => toast.error(error.message));
  }, []);

  /**
   * Reuses the app's own terminal rather than inventing a second one. adb is given by absolute
   * path because it may not be on PATH, and quoted because an SDK under "C:\Program Files" is
   * the common case on Windows.
   */
  const openShell = useCallback((serial: string, label: string) => {
    void window.runova.android
      .adbPath()
      .then((adb) => {
        useTerminalStore.getState().openSession({
          title: `adb shell · ${label}`,
          initialInput: `"${adb}" -s ${serial} shell\r`,
        });
      })
      .catch((error: Error) => toast.error(error.message));
  }, []);

  const installApk = useCallback((serial: string, label: string, paths?: string[]) => {
    void (async () => {
      const chosen = paths?.length ? paths : await window.runova.android.pickApk();
      if (chosen.length === 0) return;
      const toastId = toast.loading(`Installing on ${label}`);
      try {
        const result = await window.runova.android.installApk(serial, chosen);
        if (result.ok) toast.success(`Installed on ${label}.`, { id: toastId });
        else toast.error(result.message ?? 'The install failed.', { id: toastId });
      } catch (error) {
        toast.error((error as Error).message, { id: toastId });
      }
    })();
  }, []);

  const coldBoot = useCallback(
    (avdName: string) =>
      run(
        avdName,
        () => window.runova.android.start(avdName, { coldBoot: true }),
        `${avdName} would not start.`,
      ),
    [run],
  );

  const wipeData = useCallback(
    (avdName: string) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: `Wipe ${avdName}?`,
          description:
            'This deletes everything on the virtual device, including installed apps and accounts. The device itself stays.',
          confirmLabel: 'Wipe data',
          variant: 'destructive',
        });
        if (!confirmed) return;
        run(avdName, () => window.runova.android.wipeData(avdName), 'Could not wipe that device.');
      })();
    },
    [run],
  );

  const deleteAvd = useCallback(
    (avdName: string) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: `Delete ${avdName}?`,
          description: 'The virtual device and everything on it go. This cannot be undone.',
          confirmLabel: 'Delete',
          variant: 'destructive',
        });
        if (!confirmed) return;
        run(
          avdName,
          () => window.runova.android.deleteAvd(avdName),
          'Could not delete that device.',
        );
      })();
    },
    [run],
  );

  return {
    pending,
    coldBoot,
    wipeData,
    deleteAvd,
    screenshot,
    toggleRecording,
    rotate,
    openShell,
    installApk,
    recordingSerial: recording?.serial ?? null,
    start: useCallback(
      (avdName, options) =>
        run(
          avdName,
          () => window.runova.android.start(avdName, options),
          `${avdName} would not start.`,
        ),
      [run],
    ),
    stop: useCallback(
      (serial) => run(serial, () => window.runova.android.stop(serial), 'That would not stop.'),
      [run],
    ),
    cancelBoot: useCallback(
      (avdName) =>
        run(avdName, () => window.runova.android.cancelBoot(avdName), 'Could not cancel.'),
      [run],
    ),
  };
}
