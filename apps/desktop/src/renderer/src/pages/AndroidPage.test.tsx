import type { AndroidSdkStatus } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The renderer suite already swaps Framer Motion for a stub, but the view switcher's springs call
 * `jump` on their motion value, which the stub has no answer for. Same shape as SkillsPage.test.
 */
vi.mock('sonner', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const toast = actual.toast as Record<string, unknown>;
  return { ...actual, toast: { ...toast, info: vi.fn(), error: vi.fn(), success: vi.fn() } };
});

vi.mock('framer-motion', async (importOriginal) => {
  const stub = (await importOriginal()) as Record<string, unknown>;
  const motionValue = (initial: number) => {
    let current = initial;
    return {
      get: () => current,
      set: (next: number) => {
        current = next;
      },
      jump: (next: number) => {
        current = next;
      },
      on: () => () => undefined,
    };
  };
  return {
    ...stub,
    useMotionValue: motionValue,
    useSpring: motionValue,
    useTransform: () => motionValue(0),
    useMotionValueEvent: () => undefined,
  };
});

const { toast } = await import('sonner');
const { default: AndroidPage } = await import('./AndroidPage');

/**
 * The page has to tell the truth about the SDK before it does anything else. A machine with no
 * Android tooling is the common first visit, and the difference between "not installed" and
 * "you pointed me at the wrong folder" is the whole difference between a dead end and a fix.
 */

const NO_SDK: AndroidSdkStatus = {
  status: 'missing',
  root: null,
  source: null,
  checked: ['/home/dev/Android/Sdk', '/opt/android-sdk'],
  tools: { adb: false, emulator: false, avdmanager: false, sdkmanager: false },
  adbVersion: null,
};

const FULL_SDK: AndroidSdkStatus = {
  status: 'found',
  root: '/home/dev/Android/Sdk',
  source: 'ANDROID_HOME',
  checked: ['/home/dev/Android/Sdk'],
  tools: { adb: true, emulator: true, avdmanager: true, sdkmanager: true },
  adbVersion: '35.0.1',
};

describe('AndroidPage without an SDK', () => {
  it('says the SDK is missing and lists the paths it looked at', async () => {
    renderWithProviders(<AndroidPage />, { bridge: { 'android.sdk': NO_SDK } });

    expect(await screen.findByText('Android SDK not found')).toBeInTheDocument();
    // Showing the probed paths is what turns a failed detection into something a user can fix.
    for (const path of NO_SDK.checked) {
      expect(screen.getByText(path)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /choose sdk folder/i })).toBeInTheDocument();
  });

  it('writes the folder the picker returns and rechecks', async () => {
    const { bridge, user } = renderWithProviders(<AndroidPage />, {
      bridge: {
        'android.sdk': NO_SDK,
        'android.pickSdkPath': async () => '/opt/android-sdk',
        'android.setSdkPath': FULL_SDK,
      },
    });

    await user.click(await screen.findByRole('button', { name: /choose sdk folder/i }));

    await waitFor(() => {
      expect(bridge.$fn('android.setSdkPath')).toHaveBeenCalledWith('/opt/android-sdk');
    });
  });

  it('does not save anything when the picker is cancelled', async () => {
    const { bridge, user } = renderWithProviders(<AndroidPage />, {
      bridge: { 'android.sdk': NO_SDK, 'android.pickSdkPath': async () => null },
    });
    // The bridge creates a path's mock on first access, so take a handle before the click.
    // A cancelled picker must leave whatever override the user already had alone.
    const setSdkPath = window.runova.android.setSdkPath;

    await user.click(await screen.findByRole('button', { name: /choose sdk folder/i }));

    await waitFor(() => expect(bridge.$fn('android.pickSdkPath')).toHaveBeenCalled());
    expect(setSdkPath).not.toHaveBeenCalled();
  });
});

describe('AndroidPage with a bad override', () => {
  it('says the chosen path is not an SDK and offers to clear it', async () => {
    const bad: AndroidSdkStatus = {
      ...NO_SDK,
      status: 'override-invalid',
      root: '/home/dev/Downloads',
      source: 'override',
      checked: ['/home/dev/Downloads'],
    };
    const { bridge, user } = renderWithProviders(<AndroidPage />, {
      bridge: { 'android.sdk': bad, 'android.setSdkPath': NO_SDK },
    });

    expect(await screen.findByText(/isn't an Android SDK/i)).toBeInTheDocument();
    expect(screen.getByText('/home/dev/Downloads')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear override/i }));

    // Clearing means going back to auto-detection, which is null rather than an empty string.
    await waitFor(() => expect(bridge.$fn('android.setSdkPath')).toHaveBeenCalledWith(null));
  });
});

describe('AndroidPage with an SDK', () => {
  it('shows the platform-tools version it found', async () => {
    renderWithProviders(<AndroidPage />, { bridge: { 'android.sdk': FULL_SDK } });

    expect(await screen.findByText(/35\.0\.1/)).toBeInTheDocument();
    expect(screen.queryByText('Android SDK not found')).not.toBeInTheDocument();
  });

  it('warns about a partial SDK without hiding the page', async () => {
    const partial: AndroidSdkStatus = {
      ...FULL_SDK,
      tools: { adb: true, emulator: false, avdmanager: false, sdkmanager: false },
      adbVersion: '35.0.1',
    };
    renderWithProviders(<AndroidPage />, { bridge: { 'android.sdk': partial } });

    // adb alone is enough for physical devices, so the page stays usable and names what is missing.
    expect(
      await screen.findByText(/This SDK has no emulator, avdmanager, sdkmanager/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy command/i })).toBeInTheDocument();
    expect(screen.queryByText('Android SDK not found')).not.toBeInTheDocument();
  });
});

function snapshot(over: Record<string, unknown> = {}) {
  return {
    sdk: FULL_SDK,
    emulators: [
      {
        kind: 'emulator',
        avd: {
          name: 'Pixel_7_API_34',
          displayName: 'Pixel 7 API 34',
          device: 'pixel_7',
          manufacturer: 'Google',
          api: 34,
          tag: 'google_apis',
          abi: 'x86_64',
          playStore: false,
          ramMb: 2048,
          storageMb: 6144,
          gpuMode: 'auto',
          systemImageDir: null,
          path: null,
        },
        state: 'stopped',
        serial: null,
        progress: 0,
        adopted: false,
        usage: null,
        lastLine: null,
        error: null,
      },
    ],
    physical: [
      {
        kind: 'physical',
        device: {
          serial: 'R58M20ABCDE',
          state: 'device',
          kind: 'usb',
          model: 'Galaxy A52',
          product: 'a52qnaxx',
          device: 'a52q',
          transportId: '5',
        },
        androidVersion: '14',
        api: 34,
      },
    ],
    broken: [],
    ...over,
  };
}

describe('the device list', () => {
  const bridge = { 'android.sdk': FULL_SDK, 'android.refresh': snapshot() };

  it('counts what is there and shows a card for each device', async () => {
    renderWithProviders(<AndroidPage />, { bridge });

    expect(await screen.findByText('Pixel 7 API 34')).toBeInTheDocument();
    expect(screen.getByText('Galaxy A52')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('starts an emulator by its AVD name, not its display name', async () => {
    const { bridge: fake, user } = renderWithProviders(<AndroidPage />, { bridge });

    await user.click(await screen.findByRole('button', { name: 'Start' }));

    // avdmanager and the emulator both take the id; the display name has a space in it.
    await waitFor(() =>
      expect(fake.$fn('android.start')).toHaveBeenCalledWith('Pixel_7_API_34', undefined),
    );
  });

  it('filters by name and by serial', async () => {
    const { user } = renderWithProviders(<AndroidPage />, { bridge });
    await screen.findByText('Pixel 7 API 34');

    const search = screen.getByLabelText('Search devices');
    await user.type(search, 'galaxy');

    expect(screen.queryByText('Pixel 7 API 34')).not.toBeInTheDocument();
    expect(screen.getByText('Galaxy A52')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'R58M20');
    expect(screen.getByText('Galaxy A52')).toBeInTheDocument();
  });

  it('says so when a search matches nothing', async () => {
    const { user } = renderWithProviders(<AndroidPage />, { bridge });
    await screen.findByText('Pixel 7 API 34');

    await user.type(screen.getByLabelText('Search devices'), 'zzz');

    expect(screen.getByText('No devices match "zzz".')).toBeInTheDocument();
  });

  it('narrows to physical devices from the view switcher', async () => {
    const { user } = renderWithProviders(<AndroidPage />, { bridge });
    await screen.findByText('Pixel 7 API 34');

    await user.click(screen.getByRole('button', { name: 'Physical' }));

    expect(screen.queryByText('Pixel 7 API 34')).not.toBeInTheDocument();
    expect(screen.getByText('Galaxy A52')).toBeInTheDocument();
  });

  it('offers an empty state when there is nothing attached at all', async () => {
    renderWithProviders(<AndroidPage />, {
      bridge: {
        'android.sdk': FULL_SDK,
        'android.refresh': snapshot({ emulators: [], physical: [] }),
      },
    });

    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
  });

  it('moves a card to booting when the main process says so, without a refetch', async () => {
    const { bridge: fake } = renderWithProviders(<AndroidPage />, { bridge });
    await screen.findByText('Pixel 7 API 34');

    fake.$emit('android.onEvent', {
      kind: 'emulator',
      emulator: {
        ...snapshot().emulators[0],
        state: 'booting',
        serial: 'emulator-5554',
        progress: 55,
      },
    });

    // A boot stage that waited for the next 4s poll would make the card feel dead.
    expect(await screen.findByText('Booting Android')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Boot progress' })).toHaveAttribute(
      'aria-valuenow',
      '55',
    );
  });
});

describe('the resource meters', () => {
  it('asks for sampling while the page is open and stops on the way out', async () => {
    const { bridge, unmount } = renderWithProviders(<AndroidPage />, {
      bridge: { 'android.sdk': FULL_SDK, 'android.refresh': snapshot() },
    });
    await screen.findByText('Pixel 7 API 34');

    await waitFor(() => expect(bridge.$fn('android.watchUsage')).toHaveBeenCalledWith(true));

    unmount();

    // Leaving sampling on after the page closes would keep a CIM query running every few seconds.
    expect(bridge.$fn('android.watchUsage')).toHaveBeenCalledWith(false);
  });

  it('never asks for sampling when there is no SDK to sample', async () => {
    renderWithProviders(<AndroidPage />, { bridge: { 'android.sdk': NO_SDK } });
    const watchUsage = window.runova.android.watchUsage;

    await screen.findByText('Android SDK not found');

    expect(watchUsage).not.toHaveBeenCalled();
  });

  it('paints the meters from a usage event', async () => {
    const { bridge } = renderWithProviders(<AndroidPage />, {
      bridge: {
        'android.sdk': FULL_SDK,
        'android.refresh': snapshot({
          emulators: [
            {
              ...snapshot().emulators[0],
              state: 'running',
              serial: 'emulator-5554',
              progress: 100,
            },
          ],
        }),
      },
    });
    await screen.findByText('Pixel 7 API 34');

    bridge.$emit('android.onEvent', {
      kind: 'usage',
      bySerial: {
        'emulator-5554': { cpuPercent: 23, memoryBytes: 2_147_483_648, cpuReady: true },
      },
    });

    expect(await screen.findByText('23%')).toBeInTheDocument();
    expect(screen.getByText('2.0 GB')).toBeInTheDocument();
  });
});

describe('the deep link from the status bar', () => {
  const running = () =>
    snapshot({
      emulators: [
        { ...snapshot().emulators[0], state: 'running', serial: 'emulator-5554', progress: 100 },
      ],
    });

  it('clears any search so the device asked for cannot be hidden by it', async () => {
    renderWithProviders(<AndroidPage />, {
      bridge: { 'android.sdk': FULL_SDK, 'android.refresh': running() },
      route: '/android?device=emulator-5554',
    });

    // The card is found and pointed at rather than the page simply opening somewhere near it.
    const card = await screen.findByRole('group', { name: /Pixel 7 API 34/ });
    await waitFor(() => expect(card).toHaveAttribute('data-focused', 'true'));
  });

  it('says so when the device in the link is no longer there', async () => {
    renderWithProviders(<AndroidPage />, {
      bridge: { 'android.sdk': FULL_SDK, 'android.refresh': snapshot() },
      route: '/android?device=emulator-9999',
    });

    await screen.findByText('Pixel 7 API 34');
    // Silently landing on the page with nothing highlighted would look like a broken link.
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('That device is no longer listed.'),
    );
  });
});

describe('the New device button', () => {
  const noCmdlineTools: AndroidSdkStatus = {
    ...FULL_SDK,
    tools: { adb: true, emulator: true, avdmanager: false, sdkmanager: false },
  };

  it('stays clickable when the SDK has no command-line tools', async () => {
    renderWithProviders(<AndroidPage />, {
      bridge: { 'android.sdk': noCmdlineTools, 'android.refresh': snapshot() },
    });

    // A greyed-out button is a dead end: it cannot say that avdmanager is missing or how to get
    // it, so the button opens and the dialog explains instead.
    expect(await screen.findByRole('button', { name: /new device/i })).toBeEnabled();
  });

  it('opens a dialog that names what is missing', async () => {
    const { user } = renderWithProviders(<AndroidPage />, {
      bridge: { 'android.sdk': noCmdlineTools, 'android.refresh': snapshot() },
    });

    await user.click(await screen.findByRole('button', { name: /new device/i }));

    expect(await screen.findByText('avdmanager')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /how to install/i })).toBeInTheDocument();
  });

  it('opens the real form when the tools are there', async () => {
    const { user } = renderWithProviders(<AndroidPage />, {
      bridge: {
        'android.sdk': FULL_SDK,
        'android.refresh': snapshot(),
        'android.listSystemImages': [],
        'android.listDeviceProfiles': ['pixel_7'],
      },
    });

    await user.click(await screen.findByRole('button', { name: /new device/i }));

    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
  });
});
