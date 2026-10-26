import type { AndroidSdkStatus, AppSettings } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { AndroidSdkSettings } from './AndroidSdkSettings';

/**
 * The SDK override is the escape hatch for a machine where detection guesses wrong, so the card
 * has to say what it found, where it came from, and let the user replace or clear it.
 */

const DETECTED: AndroidSdkStatus = {
  status: 'found',
  root: '/home/dev/Android/Sdk',
  source: 'ANDROID_HOME',
  checked: ['/home/dev/Android/Sdk'],
  tools: { adb: true, emulator: true, avdmanager: true, sdkmanager: true },
  adbVersion: '35.0.1',
};

const settings = { androidSdkPath: null } as AppSettings;

describe('AndroidSdkSettings', () => {
  it('shows the detected path and where it came from', async () => {
    renderWithProviders(<AndroidSdkSettings settings={settings} />, {
      bridge: { 'android.sdk': DETECTED },
    });

    expect(await screen.findByText('/home/dev/Android/Sdk')).toBeInTheDocument();
    // Knowing it came from ANDROID_HOME is what tells the user where to change it.
    expect(screen.getByText(/ANDROID_HOME/)).toBeInTheDocument();
  });

  it('saves the folder the picker returns', async () => {
    const { bridge, user } = renderWithProviders(<AndroidSdkSettings settings={settings} />, {
      bridge: {
        'android.sdk': DETECTED,
        'android.pickSdkPath': async () => '/opt/android-sdk',
        'android.setSdkPath': async () => ({ ...DETECTED, source: 'override' }),
      },
    });

    await user.click(await screen.findByRole('button', { name: /browse/i }));

    await waitFor(() =>
      expect(bridge.$fn('android.setSdkPath')).toHaveBeenCalledWith('/opt/android-sdk'),
    );
  });

  it('offers no Clear when the SDK was detected rather than set here', async () => {
    renderWithProviders(<AndroidSdkSettings settings={settings} />, {
      bridge: { 'android.sdk': DETECTED },
    });

    await screen.findByText('/home/dev/Android/Sdk');
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
  });

  it('clears an override back to auto-detection', async () => {
    const { bridge, user } = renderWithProviders(
      <AndroidSdkSettings settings={{ androidSdkPath: '/opt/sdk' } as AppSettings} />,
      { bridge: { 'android.sdk': DETECTED, 'android.setSdkPath': async () => DETECTED } },
    );

    await user.click(await screen.findByRole('button', { name: /clear/i }));

    // Null is "detect again", which an empty string would not be.
    await waitFor(() => expect(bridge.$fn('android.setSdkPath')).toHaveBeenCalledWith(null));
  });

  it('says plainly when nothing was found', async () => {
    renderWithProviders(<AndroidSdkSettings settings={settings} />, {
      bridge: {
        'android.sdk': {
          ...DETECTED,
          status: 'missing',
          root: null,
          source: null,
          adbVersion: null,
        },
      },
    });

    expect(await screen.findByText(/No Android SDK found/i)).toBeInTheDocument();
  });
});
