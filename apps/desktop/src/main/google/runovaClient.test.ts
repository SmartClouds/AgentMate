import { describe, expect, it } from 'vitest';
import { runovaGoogleClient } from './runovaClient';

/** Runova's own Google client comes in at build time; a build without it has no one-click sign-in. */
describe('runovaGoogleClient', () => {
  it('reads the client from the build environment', () => {
    expect(
      runovaGoogleClient({
        MAIN_VITE_GOOGLE_CLIENT_ID: ' 123.apps.googleusercontent.com ',
        MAIN_VITE_GOOGLE_CLIENT_SECRET: 'GOCSPX-abc',
      }),
    ).toEqual({ clientId: '123.apps.googleusercontent.com', clientSecret: 'GOCSPX-abc' });
  });

  it('takes a client without a secret', () => {
    expect(runovaGoogleClient({ MAIN_VITE_GOOGLE_CLIENT_ID: 'id' })).toEqual({ clientId: 'id' });
  });

  it('reads the build environment by default', () => {
    expect(runovaGoogleClient()).toEqual(
      runovaGoogleClient(import.meta.env as Record<string, string | undefined>),
    );
  });

  it('has none when the build carries no id', () => {
    expect(runovaGoogleClient({})).toBeNull();
    expect(runovaGoogleClient({ MAIN_VITE_GOOGLE_CLIENT_ID: '  ' })).toBeNull();
  });
});
