interface SentryEnv {
  dsn?: string;
  environment?: string;
  release?: string;
}

/** Sentry init options from the environment. An empty DSN turns Sentry off and breaks nothing. */
export function sentryOptions({ dsn, environment, release }: SentryEnv) {
  if (!dsn) return { enabled: false };
  return {
    enabled: true,
    dsn,
    environment: environment || 'production',
    release: release || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
  };
}
