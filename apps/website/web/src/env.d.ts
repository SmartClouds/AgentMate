interface ImportMetaEnv {
  readonly PUBLIC_SENTRY_DSN?: string;
  /** Set at build time from the environment by astro.config.mjs. */
  readonly SENTRY_ENVIRONMENT: string;
  readonly SENTRY_RELEASE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
