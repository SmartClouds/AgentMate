import type { AndroidDevice } from '@runova/core';
import { useCallback, useState } from 'react';
import { Upload } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * Dropping an APK anywhere on the page installs it.
 *
 * With one device up there is nothing to ask, so the drop just goes there. With several, the
 * overlay says to pick one and the drop lands on whichever card it was over. A file that is not
 * an APK is refused out loud rather than ignored, which is the difference between "it did not
 * work" and "nothing happened".
 *
 * Paths come from `shell.pathForFile`, since Electron no longer exposes `File.path`.
 */

function apkPathsFrom(event: React.DragEvent): { paths: string[]; rejected: number } {
  const files = Array.from(event.dataTransfer?.files ?? []);
  const paths: string[] = [];
  let rejected = 0;
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.apk')) {
      rejected += 1;
      continue;
    }
    const path = window.runova.shell.pathForFile(file);
    if (path) paths.push(path);
  }
  return { paths, rejected };
}

/** True while the drag actually carries files, so dragging text around does not arm the overlay. */
function carriesFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

interface ApkDropZoneProps {
  /** Devices an APK can be installed on right now. */
  targets: AndroidDevice[];
  onInstall: (serial: string, label: string, paths: string[]) => void;
  onReject: (message: string) => void;
  children: React.ReactNode;
  className?: string;
}

function labelOf(device: AndroidDevice): { serial: string; label: string } {
  return device.kind === 'emulator'
    ? { serial: device.serial ?? '', label: device.avd.displayName }
    : { serial: device.device.serial, label: device.device.model ?? device.device.serial };
}

export function ApkDropZone({
  targets,
  onInstall,
  onReject,
  children,
  className,
}: ApkDropZoneProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  const only = targets.length === 1 ? labelOf(targets[0]) : null;

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (!carriesFiles(event)) return;

      const { paths, rejected } = apkPathsFrom(event);
      if (paths.length === 0) {
        onReject(
          rejected > 0
            ? 'Only .apk files can be installed on a device.'
            : 'That file could not be read.',
        );
        return;
      }
      if (!only) {
        onReject(
          targets.length === 0
            ? 'Start an emulator or plug in a phone first.'
            : 'Drop the APK on the device you want it on.',
        );
        return;
      }
      onInstall(only.serial, only.label, paths);
    },
    [only, onInstall, onReject, targets.length],
  );

  return (
    <div
      className={cn('relative', className)}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Only the drag actually leaving the wrapper counts, not moving between children.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      {children}
      {dragging && (
        <div
          aria-hidden
          className={cn(
            'glass pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-[calc(var(--radius)+2px)]',
            // An outline rather than a border: the global border colour would win over a tinted
            // border utility and leave the dashes grey.
            'outline-2 -outline-offset-4 outline-dashed outline-primary/50',
          )}
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
            <Upload className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium">
            {only ? `Install on ${only.label}` : 'Drop the APK on a device'}
          </p>
          <p className="text-xs text-muted-foreground">Only .apk files</p>
        </div>
      )}
    </div>
  );
}
