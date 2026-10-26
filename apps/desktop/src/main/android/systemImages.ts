import {
  type AndroidActionResult,
  parseSdkManagerList,
  type SdkManagerProgress,
  type SystemImage,
  sortSystemImages,
} from '@runova/core';
import { runSdkManager, runSdkManagerStreaming } from './exec';
import type { ResolvedAndroidSdk } from './sdk';

/**
 * The system images that could be installed, and installing one.
 *
 * `sdkmanager --list` is the only source for what is available, and it is slow and hits the
 * network, so the answer is cached until something asks for a fresh one. Installing is a download
 * of several hundred megabytes that stops partway to ask about licences.
 */

/** A package id reaches a command line, so only the shape we actually use is allowed through. */
const SYSTEM_IMAGE_ID = /^system-images;android-[A-Za-z0-9._-]+;[A-Za-z0-9_-]+;[A-Za-z0-9_-]+$/;

export function isSystemImageId(id: string): boolean {
  return SYSTEM_IMAGE_ID.test(id);
}

/**
 * What `sdkmanager --list` had to say. The error is carried rather than swallowed: "nothing to
 * offer" and "could not ask" look identical to a user otherwise, and only one of them is worth
 * retrying.
 */
export interface AvailableImages {
  images: SystemImage[];
  error: string | null;
}

const CACHE_TTL_MS = 10 * 60_000;
let cached: { at: number; images: SystemImage[] } | null = null;

export function clearAvailableSystemImages(): void {
  cached = null;
}

export async function listAvailableSystemImages(
  sdk: ResolvedAndroidSdk,
  force = false,
): Promise<AvailableImages> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { images: cached.images, error: null };
  }
  try {
    // The full list, not `--list_installed`: the whole point here is what is not installed yet.
    const stdout = await runSdkManager(sdk, ['--list'], {
      timeoutMs: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const images = sortSystemImages(parseSdkManagerList(stdout).available);
    // Only a good answer is cached, so a retry after a failure really does try again.
    cached = { at: Date.now(), images };
    return { images, error: null };
  } catch (error) {
    return {
      images: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Downloads and installs one system image.
 *
 * The licence question is answered with a yes, which is only sound because the renderer makes the
 * user accept the terms before this is ever called. Answering it here rather than there is the
 * difference between an install and a process sitting on stdin until it times out.
 */
export async function installSystemImage(
  sdk: ResolvedAndroidSdk,
  packageId: string,
  onProgress: (progress: SdkManagerProgress) => void,
): Promise<AndroidActionResult> {
  if (!isSystemImageId(packageId)) {
    return { ok: false, message: 'That is not a system image package.' };
  }

  let lastLine = '';
  try {
    await runSdkManagerStreaming(sdk, [packageId], {
      onLine: (line) => {
        if (line.trim()) lastLine = line.trim();
      },
      onProgress,
      // sdkmanager asks once per licence it has not seen before.
      onPrompt: () => 'y\n',
    });
    return { ok: true };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // sdkmanager's own last words are more useful than "exited with 1".
    return { ok: false, message: lastLine || raw };
  } finally {
    // Whatever happened, what is installed has probably changed.
    clearAvailableSystemImages();
  }
}
