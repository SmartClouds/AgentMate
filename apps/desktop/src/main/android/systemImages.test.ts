import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Listing and installing system images.
 *
 * Installing one is a several-hundred-megabyte download that stops partway to ask about licences,
 * so the two things that matter are that progress actually reaches the caller and that the
 * licence question is answered rather than left blocking forever.
 */

const state = vi.hoisted(() => ({
  calls: [] as { args: string[] }[],
  /** Lines the fake sdkmanager prints, in order. */
  output: [] as string[],
  stdin: [] as string[],
  exitCode: 0,
  listOutput: '',
  listError: null as string | null,
}));

/** Stands in for the real runner, with the same contract: a line, a parsed progress line where
 * there is one, and a prompt whose answer goes to stdin. */
vi.mock('./exec', async () => {
  const { isLicensePrompt, parseSdkManagerProgress } = await import('@runova/core');
  return {
    AndroidCommandError: class extends Error {},
    AndroidToolMissingError: class extends Error {},
    runSdkManager: (_sdk: unknown, args: string[]) => {
      state.calls.push({ args });
      if (state.listError) return Promise.reject(new Error(state.listError));
      return Promise.resolve(state.listOutput);
    },
    runSdkManagerStreaming: (
      _sdk: unknown,
      args: string[],
      handlers: {
        onLine?(line: string): void;
        onProgress?(progress: { percent: number; label: string }): void;
        onPrompt?(line: string): string | undefined;
      },
    ) => {
      state.calls.push({ args });
      for (const line of state.output) {
        handlers.onLine?.(line);
        const progress = parseSdkManagerProgress(line);
        if (progress) handlers.onProgress?.(progress);
        if (isLicensePrompt(line)) {
          const answer = handlers.onPrompt?.(line);
          if (answer) state.stdin.push(answer.trim());
        }
      }
      return state.exitCode === 0
        ? Promise.resolve()
        : Promise.reject(new Error('sdkmanager failed'));
    },
  };
});

const sdk = { paths: { sdkmanager: '/sdk/sdkmanager' } } as never;

const LIST = [
  'Installed packages:',
  '  Path | Version | Description | Location',
  '  platform-tools | 35.0.1 | Platform-Tools | x',
  '',
  'Available Packages:',
  '  Path | Version | Description',
  '  system-images;android-35;google_apis;x86_64 | 4 | Google APIs | ',
  '  system-images;android-34;google_apis_playstore;x86_64 | 9 | Google Play | ',
  '  build-tools;35.0.0 | 35.0.0 | Build-Tools | ',
  '',
].join('\n');

beforeEach(() => {
  state.calls.length = 0;
  state.output.length = 0;
  state.stdin.length = 0;
  state.exitCode = 0;
  state.listOutput = LIST;
  state.listError = null;
  vi.resetModules();
});

describe('listAvailableSystemImages', () => {
  it('offers the images that are not installed yet, newest API first', async () => {
    const { listAvailableSystemImages } = await import('./systemImages');

    const { images, error } = await listAvailableSystemImages(sdk);

    expect(error).toBeNull();
    expect(images.map((image) => image.api)).toEqual([35, 34]);
    // Build tools are in the same list and are not something this dialog can use.
    expect(images.every((image) => image.id.startsWith('system-images;'))).toBe(true);
  });

  it('asks the full list, since the installed-only one has nothing to offer', async () => {
    const { listAvailableSystemImages } = await import('./systemImages');

    await listAvailableSystemImages(sdk);

    expect(state.calls[0].args).toContain('--list');
  });

  it('caches a good answer, and looks again when asked to', async () => {
    const { listAvailableSystemImages } = await import('./systemImages');

    await listAvailableSystemImages(sdk);
    await listAvailableSystemImages(sdk);
    // The full list reaches out to the network and takes most of a minute.
    expect(state.calls).toHaveLength(1);

    await listAvailableSystemImages(sdk, true);
    expect(state.calls).toHaveLength(2);
  });

  it('says why it came back empty instead of looking like there is nothing to install', async () => {
    const { listAvailableSystemImages } = await import('./systemImages');
    state.listError = 'sdkmanager needs a Java runtime and could not find one.';

    const { images, error } = await listAvailableSystemImages(sdk);

    // One vague sentence for every possible failure is what made this impossible to debug.
    expect(images).toEqual([]);
    expect(error).toContain('Java');
  });

  it('separates "nothing offered" from "could not ask"', async () => {
    const { listAvailableSystemImages } = await import('./systemImages');
    state.listOutput = ['Installed packages:', '  platform-tools | 35.0.1 | x | y', ''].join('\n');

    const { images, error } = await listAvailableSystemImages(sdk);

    // sdkmanager answered; it just had no images to offer. That is not an error.
    expect(images).toEqual([]);
    expect(error).toBeNull();
  });

  it('does not cache a failure, so a retry actually tries again', async () => {
    const { listAvailableSystemImages } = await import('./systemImages');
    state.listError = 'network is down';

    await listAvailableSystemImages(sdk);
    await listAvailableSystemImages(sdk);

    expect(state.calls).toHaveLength(2);
  });
});

describe('installSystemImage', () => {
  const id = 'system-images;android-34;google_apis;x86_64';

  it('installs the package it was given', async () => {
    const { installSystemImage } = await import('./systemImages');

    const result = await installSystemImage(sdk, id, () => undefined);

    expect(result.ok).toBe(true);
    expect(state.calls[0].args).toContain(id);
  });

  it('reports progress as the download moves', async () => {
    const { installSystemImage } = await import('./systemImages');
    state.output = [
      '[=====                         ] 20% Downloading x86_64.zip',
      '[===================           ] 70% Downloading x86_64.zip',
      '[==============================] 100% Unzipping...',
    ];
    const seen: (number | null)[] = [];

    await installSystemImage(sdk, id, (progress) => seen.push(progress.percent));

    expect(seen).toEqual([20, 70, 100]);
  });

  it('answers the licence question instead of blocking on it', async () => {
    const { installSystemImage } = await import('./systemImages');
    state.output = ['License android-sdk-license:', 'Accept? (y/N): ', '[=] 100% done'];

    await installSystemImage(sdk, id, () => undefined);

    // Left unanswered, sdkmanager waits on stdin until the timeout kills it.
    expect(state.stdin).toEqual(['y']);
  });

  it('refuses a package id that is not a system image', async () => {
    const { installSystemImage } = await import('./systemImages');

    const result = await installSystemImage(sdk, 'platform-tools; rm -rf /', () => undefined);

    expect(result.ok).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('says what went wrong when the install fails', async () => {
    const { installSystemImage } = await import('./systemImages');
    state.exitCode = 1;

    const result = await installSystemImage(sdk, id, () => undefined);

    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });
});
