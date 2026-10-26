import type { SystemImage } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CreateAvdDialog } from './CreateAvdDialog';

/**
 * The create dialog has to catch what avdmanager would reject before it spawns anything, and it
 * has to be honest when there is nothing to create a device from.
 */

const IMAGES: SystemImage[] = [
  {
    id: 'system-images;android-34;google_apis;x86_64',
    api: 34,
    tag: 'google_apis',
    abi: 'x86_64',
    playStore: false,
    version: '12',
    description: '',
  },
];

const TOOLS = { adb: true, emulator: true, avdmanager: true, sdkmanager: true };

function setup(
  overrides: Record<string, unknown> = {},
  existingNames: string[] = [],
  tools = TOOLS,
) {
  const onCreated = vi.fn();
  const view = renderWithProviders(
    <CreateAvdDialog
      open
      onOpenChange={vi.fn()}
      existingNames={existingNames}
      onCreated={onCreated}
      tools={tools}
    />,
    {
      bridge: {
        'android.listSystemImages': IMAGES,
        'android.listDeviceProfiles': ['pixel_7', 'pixel_tablet'],
        'android.createAvd': { ok: true },
        ...overrides,
      },
    },
  );
  return { ...view, onCreated };
}

describe('CreateAvdDialog', () => {
  it('cannot be submitted with no name', async () => {
    setup();

    await screen.findByLabelText('Name');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('shows the id a name with spaces will really be saved under', async () => {
    const { user } = setup();

    await user.type(await screen.findByLabelText('Name'), 'Pixel 7 test');

    // avdmanager rejects spaces and Studio does not, so the rename is shown rather than sprung.
    expect(screen.getByText('Pixel_7_test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('refuses a duplicate without asking the main process', async () => {
    const { user, bridge } = setup({}, ['Pixel_7_test']);

    await user.type(await screen.findByLabelText('Name'), 'Pixel 7 test');

    expect(screen.getByText(/already a virtual device called Pixel_7_test/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(() => bridge.$fn('android.createAvd')).toThrow();
  });

  it('creates with the id, the chosen image and the chosen profile', async () => {
    const { user, bridge } = setup();

    await user.type(await screen.findByLabelText('Name'), 'My Pixel');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(bridge.$fn('android.createAvd')).toHaveBeenCalledWith({
        name: 'My_Pixel',
        systemImageId: 'system-images;android-34;google_apis;x86_64',
        device: 'pixel_7',
      }),
    );
  });

  it('offers images to install instead of a command to copy', async () => {
    setup({
      'android.listSystemImages': [],
      'android.availableSystemImages': { images: AVAILABLE, error: null },
    });

    // A command to paste elsewhere is a dead end; the point is to fix it from here.
    expect(await screen.findByText(/No system images are installed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/image to download/i)).toBeInTheDocument();
    expect(screen.queryByText(/sdkmanager "system-images/)).not.toBeInTheDocument();
  });
});

describe('when the SDK has no command-line tools', () => {
  const noAvdmanager = { adb: true, emulator: true, avdmanager: false, sdkmanager: false };

  it('explains what to install instead of leaving a dead Create button', async () => {
    setup({}, [], noAvdmanager);

    // Creating an AVD needs avdmanager, and an SDK installed by Android Studio does not ship it
    // by default. Saying so is the whole point: a disabled button teaches nobody anything.
    // The tool it needs, and where that tool comes from.
    expect(await screen.findByText('avdmanager')).toBeInTheDocument();
    expect(screen.getByText(/SDK Tools tab/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /how to install/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });

  it('does not ask for a name it cannot use', async () => {
    setup({}, [], noAvdmanager);

    await screen.findByRole('button', { name: /how to install/i });
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });
});

const AVAILABLE = [
  {
    id: 'system-images;android-35;google_apis;x86_64',
    api: 35,
    tag: 'google_apis',
    abi: 'x86_64',
    playStore: false,
    version: '4',
    description: '',
  },
  {
    id: 'system-images;android-34;google_apis_playstore;x86_64',
    api: 34,
    tag: 'google_apis_playstore',
    abi: 'x86_64',
    playStore: true,
    version: '9',
    description: '',
  },
];

describe('installing a system image from the dialog', () => {
  const noImages = {
    'android.listSystemImages': [],
    'android.availableSystemImages': { images: AVAILABLE, error: null },
    'android.installSystemImage': { ok: true },
  };

  it('will not download until the licence is accepted', async () => {
    const { user } = setup(noImages);

    await screen.findByLabelText(/image to download/i);
    // Accepting a licence on someone's behalf is not ours to do.
    expect(screen.getByRole('button', { name: /download and install/i })).toBeDisabled();

    await user.click(screen.getByLabelText(/accept the Android SDK licence/i));
    expect(screen.getByRole('button', { name: /download and install/i })).toBeEnabled();
  });

  it('installs the image that was picked', async () => {
    const { bridge, user } = setup(noImages);

    await screen.findByLabelText(/image to download/i);
    await user.click(screen.getByLabelText(/accept the Android SDK licence/i));
    await user.click(screen.getByRole('button', { name: /download and install/i }));

    await waitFor(() =>
      expect(bridge.$fn('android.installSystemImage')).toHaveBeenCalledWith(
        'system-images;android-35;google_apis;x86_64',
      ),
    );
  });

  it('shows the download moving rather than a frozen dialog', async () => {
    const { bridge, user } = setup({
      ...noImages,
      // Never resolves, so the dialog stays in its downloading state.
      'android.installSystemImage': () => new Promise(() => undefined),
    });

    await screen.findByLabelText(/image to download/i);
    await user.click(screen.getByLabelText(/accept the Android SDK licence/i));
    await user.click(screen.getByRole('button', { name: /download and install/i }));

    bridge.$emit('android.onEvent', {
      kind: 'task',
      id: 'install:system-images;android-35;google_apis;x86_64',
      label: 'Downloading x86_64.zip',
      progress: 42,
      done: false,
    });

    const bar = await screen.findByRole('progressbar', { name: /installing/i });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('Downloading x86_64.zip')).toBeInTheDocument();
  });

  it('moves on to the form once the image is there', async () => {
    const { bridge, user } = setup(noImages);

    await screen.findByLabelText(/image to download/i);
    await user.click(screen.getByLabelText(/accept the Android SDK licence/i));
    await user.click(screen.getByRole('button', { name: /download and install/i }));

    // The installed list is what the form picks from, so it has to be asked again.
    await waitFor(() => expect(bridge.$fn('android.listSystemImages')).toHaveBeenCalledTimes(2));
  });

  it('says so when the download fails, and lets it be retried', async () => {
    const { user } = setup({
      ...noImages,
      'android.installSystemImage': { ok: false, message: 'Could not reach the server.' },
    });

    await screen.findByLabelText(/image to download/i);
    await user.click(screen.getByLabelText(/accept the Android SDK licence/i));
    await user.click(screen.getByRole('button', { name: /download and install/i }));

    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download and install/i })).toBeEnabled();
  });

  it('says plainly when there is nothing to offer', async () => {
    setup({
      'android.listSystemImages': [],
      'android.availableSystemImages': { images: [], error: 'sdkmanager could not run.' },
    });

    // What the SDK actually said, plus a way to ask again, rather than one vague sentence.
    expect(await screen.findByText('sdkmanager could not run.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('while the installed images are still loading', () => {
  it('says it is looking rather than "No results found"', async () => {
    renderWithProviders(
      <CreateAvdDialog
        open
        onOpenChange={vi.fn()}
        existingNames={[]}
        onCreated={vi.fn()}
        tools={TOOLS}
      />,
      {
        bridge: {
          // Never resolves, so the dialog stays in its loading state.
          'android.listSystemImages': () => new Promise(() => undefined),
          'android.listDeviceProfiles': ['pixel_7'],
        },
      },
    );

    // An empty dropdown reading "No results found" looks like there is nothing to install, when
    // the truth is the list has not arrived yet.
    expect(await screen.findByText(/Reading the installed images/i)).toBeInTheDocument();
    expect(screen.queryByText('No results found')).not.toBeInTheDocument();
  });
});
