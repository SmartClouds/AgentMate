/**
 * Runova's own Google OAuth client, for the one-click "Sign in with Google" (E40). It is a Desktop
 * client, whose secret Google does not treat as confidential, and it comes in at build time
 * through electron-vite's `MAIN_VITE_` variables. A build without it still works: the user brings
 * their own client instead.
 */

export interface GoogleClient {
  clientId: string;
  clientSecret?: string;
}

type BuildEnv = Record<string, string | undefined>;

function buildEnv(): BuildEnv {
  return (import.meta as ImportMeta & { env?: BuildEnv }).env ?? {};
}

export function runovaGoogleClient(env: BuildEnv = buildEnv()): GoogleClient | null {
  const clientId = env.MAIN_VITE_GOOGLE_CLIENT_ID?.trim();
  if (!clientId) return null;
  const clientSecret = env.MAIN_VITE_GOOGLE_CLIENT_SECRET?.trim();
  return clientSecret ? { clientId, clientSecret } : { clientId };
}
