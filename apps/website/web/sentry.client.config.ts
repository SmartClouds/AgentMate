import * as Sentry from '@sentry/astro';
import { sentryOptions } from './src/lib/sentry';

// Only bundled when PUBLIC_SENTRY_DSN is set at build time (see astro.config.mjs).
Sentry.init(
  sentryOptions({
    dsn: import.meta.env.PUBLIC_SENTRY_DSN,
    environment: import.meta.env.SENTRY_ENVIRONMENT,
    release: import.meta.env.SENTRY_RELEASE,
  }),
);
