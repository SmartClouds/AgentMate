import { describe, expect, it } from 'vitest';
import { sentryOptions } from '../src/lib/sentry';

describe('sentryOptions', () => {
  it('turns Sentry off when the DSN is empty', () => {
    expect(sentryOptions({ dsn: '', environment: 'production', release: '1.0.0' })).toEqual({
      enabled: false,
    });
    expect(sentryOptions({})).toEqual({ enabled: false });
  });

  it('passes the DSN, environment and release from the environment', () => {
    expect(
      sentryOptions({
        dsn: 'https://key@o1.ingest.sentry.io/1',
        environment: 'staging',
        release: '',
      }),
    ).toEqual({
      enabled: true,
      dsn: 'https://key@o1.ingest.sentry.io/1',
      environment: 'staging',
      release: undefined,
      sendDefaultPii: false,
      tracesSampleRate: 0.1,
    });
  });

  it('defaults the environment to production', () => {
    expect(sentryOptions({ dsn: 'https://key@o1.ingest.sentry.io/1' }).environment).toBe(
      'production',
    );
  });
});
