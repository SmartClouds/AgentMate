import { join } from 'node:path';
import { app, ipcMain, net, shell } from 'electron';
import { IPC } from '../../../shared/ipcChannels';
import { GOOGLE_CLOUD_PROVIDER, GOOGLE_REVOKE_URL } from '../../google/provider';
import { type GoogleClient, runovaGoogleClient } from '../../google/runovaClient';
import { GoogleCloudState, googleCloudFilePort } from '../../google/state';
import { GOOGLE_TOKEN_URL, GoogleTokens } from '../../google/tokens';
import { registerDeployRecaptchaHandlers } from '../../ipc/deployRecaptcha';
import { sendToWindow } from '../../ipc/send';
import { getMainWindow } from '../../mainWindow';
import { signInWithLoopback } from '../../oauth/loopback';
import {
  decryptSecret,
  encryptSecret,
  isLockedEnvelope,
  onVaultUnlocked,
  registerSealedSecretStore,
} from '../../ssh/vault';
import { isE2E } from '../../testMode';
import { GOOGLE_API_BASES, type GoogleApiBases, RecaptchaClient } from './client';
import { RecaptchaService } from './service';

/**
 * Wires the reCAPTCHA page (E40) into Electron. The Google sign-ins are sealed with the Servers
 * vault, so they move with a passkey change like the other stores. HTTP goes through `net.fetch`,
 * which follows the app's proxy settings.
 */

const fetchWithNet: typeof fetch = (url, init) => net.fetch(url as string, init);

/**
 * The Google fake for e2e runs, served on loopback by the test. Honoured only in an e2e run of an
 * unpackaged build: a packaged app always talks to Google.
 */
function e2eGoogle(): { base: string; client: GoogleClient } | null {
  const base = process.env.RUNOVA_E2E_GOOGLE_API;
  if (!isE2E || app.isPackaged || !base || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base))
    return null;
  return { base, client: { clientId: 'e2e-client.apps.googleusercontent.com' } };
}

export function registerRecaptchaIpc(): void {
  const fake = e2eGoogle();
  const bases: GoogleApiBases = fake
    ? {
        resourceManager: `${fake.base}/rm`,
        serviceUsage: `${fake.base}/su`,
        recaptcha: `${fake.base}/rc`,
      }
    : GOOGLE_API_BASES;
  const provider = fake
    ? {
        ...GOOGLE_CLOUD_PROVIDER,
        authorizeUrl: `${fake.base}/oauth/auth`,
        tokenUrl: `${fake.base}/oauth/token`,
      }
    : GOOGLE_CLOUD_PROVIDER;

  const state = new GoogleCloudState(
    googleCloudFilePort(join(app.getPath('userData'), 'data', 'google-cloud.json')),
  );
  registerSealedSecretStore(state.sealedKeys);
  const tokens = new GoogleTokens({
    fetch: fetchWithNet,
    tokenUrl: fake ? provider.tokenUrl : GOOGLE_TOKEN_URL,
  });
  const service = new RecaptchaService({
    state,
    tokens,
    seal: encryptSecret,
    unseal: decryptSecret,
    isLocked: isLockedEnvelope,
    provider,
    runovaClient: fake ? fake.client : runovaGoogleClient(),
    signIn: (request, signal) =>
      signInWithLoopback(
        { openExternal: (url) => shell.openExternal(url), fetch: fetchWithNet, signal },
        request,
      ),
    revoke: async (refreshToken) => {
      await fetchWithNet(fake ? `${fake.base}/oauth/revoke` : GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
    },
    client: (accessToken) => new RecaptchaClient({ fetch: fetchWithNet, accessToken, bases }),
    onProgress: (progress) =>
      sendToWindow(getMainWindow(), IPC.deployRecaptcha.onProgress, progress),
  });
  // A passkey unlock makes a different set of envelopes readable; renew from scratch after it.
  onVaultUnlocked(() => tokens.clear());

  registerDeployRecaptchaHandlers({
    ipc: ipcMain,
    service,
    guard: (event) => {
      const win = getMainWindow();
      return (
        !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      );
    },
  });
}
