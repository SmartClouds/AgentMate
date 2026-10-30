import * as Sentry from '@sentry/astro';
import { sentryOptions } from './src/lib/sentry';

// The server reads its environment at runtime, so a deploy can change the DSN without a rebuild.
Sentry.init(
  sentryOptions({
    dsn: process.env.PUBLIC_SENTRY_DSN || import.meta.env.PUBLIC_SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || import.meta.env.SENTRY_ENVIRONMENT,
    release: process.env.SENTRY_RELEASE || import.meta.env.SENTRY_RELEASE,
  }),
);
