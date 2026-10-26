import { posix, win32 } from 'node:path';
import type { DevDetection, DevItemId, DevOs } from '@runova/core';
import type { UserPathResult } from './userPath';

/**
 * "Add to PATH" for a tool that is installed but only found at a fallback location (Flutter in
 * ~/develop/flutter/bin, Git under Program Files). The folder is worked out here from where the
 * tool was found just now. The renderer only names the tool, so it can never choose which folder
 * goes on the PATH.
 */

export interface AddToPathDeps {
  os: DevOs;
  detect: (id: DevItemId, options: { force: true }) => Promise<DevDetection>;
  addToUserPath: (dir: string) => Promise<UserPathResult>;
}

const NOT_APPLICABLE = 'That tool is already on your PATH, or was not found.';

export async function addToolToPath(id: DevItemId, deps: AddToPathDeps): Promise<UserPathResult> {
  // Looked at again, not read from memory: the tool may have moved or been put on PATH since.
  const detection = await deps.detect(id, { force: true });
  if (detection.state !== 'found' || detection.onPath || typeof detection.path !== 'string') {
    throw new Error(NOT_APPLICABLE);
  }
  const dir = deps.os === 'win32' ? win32.dirname(detection.path) : posix.dirname(detection.path);
  return deps.addToUserPath(dir);
}
