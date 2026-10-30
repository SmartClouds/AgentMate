import type { DeployCloudDriveKind } from '../../../shared/deployServerBackupsTypes';
import {
  type LoopbackSignInDeps,
  type OAuthProvider,
  authorizationUrl as providerAuthorizationUrl,
  signInWithLoopback as signInWithProvider,
} from '../../oauth/loopback';

/**
 * Signing in to Google Drive or OneDrive for a backup destination (E28), with the user's own OAuth
 * client, so Runova registers nothing with either. The loopback flow itself lives in
 * `main/oauth/loopback.ts`; the refresh token goes straight on to the core, which seals it.
 */

export type CloudProvider = OAuthProvider;
export type { LoopbackSignInDeps };

export const CLOUD_PROVIDERS: Record<DeployCloudDriveKind, CloudProvider> = {
  googleDrive: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive.file',
    extra: { access_type: 'offline', prompt: 'consent' },
    label: 'Google',
  },
  oneDrive: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'Files.ReadWrite.AppFolder offline_access',
    extra: {},
    label: 'Microsoft',
  },
};

export interface LoopbackSignInRequest {
  kind: DeployCloudDriveKind;
  clientId: string;
  clientSecret?: string;
}

export function authorizationUrl(
  kind: DeployCloudDriveKind,
  options: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  return providerAuthorizationUrl(CLOUD_PROVIDERS[kind], options);
}

/** Runs the whole sign-in and gives back the refresh token, which is all a destination keeps. */
export async function signInWithLoopback(
  deps: LoopbackSignInDeps,
  request: LoopbackSignInRequest,
): Promise<{ refreshToken: string }> {
  const { refreshToken } = await signInWithProvider(deps, {
    provider: CLOUD_PROVIDERS[request.kind],
    clientId: request.clientId,
    clientSecret: request.clientSecret,
  });
  return { refreshToken };
}
