# Runova website

The site at runovahq.com: Astro on bun, with React islands, MDX, Tailwind CSS 4 and shadcn/ui. It
sits outside the pnpm workspace and has its own `bun.lock` and `biome.json`. Specs:
[E40W](../../../docs/epics/40-website.md) and the [design spec](../../../docs/website/design.md).

## Commands

Run these here, or `pnpm website:dev | website:build | website:test | website:e2e` from the root.

| Command                         | What it does                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile` | Installs the pinned dependencies                                                          |
| `bun run dev`                   | Dev server; `/api` and `/media` go to `WEBSITE_API_URL` (default `http://localhost:5180`) |
| `bun run lint`                  | Biome                                                                                     |
| `bun run check`                 | `astro check` (types in `.astro`, `.ts` and `.tsx`)                                       |
| `bun run test`                  | Vitest, with the Astro container API for components                                       |
| `bun run build`                 | Static pages plus the Node adapter server in `dist/`                                      |
| `bun run start`                 | Serves `dist/` with `bun ./dist/server/entry.mjs` (`HOST`, `PORT`)                        |
| `bun run e2e`                   | Builds, starts the server under bun and runs Playwright                                   |

## Environment

An empty value turns the feature off and breaks nothing.

| Variable                               | Used for                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `SITE_URL`                             | Canonical and Open Graph URLs (default `https://runovahq.com`)           |
| `WEBSITE_API_URL`                      | The dev proxy target                                                     |
| `WEBSITE_API_INTERNAL_URL`             | Server-side API calls (later tasks)                                      |
| `PUBLIC_SENTRY_DSN`                    | Sentry; read at build time for the browser and at runtime for the server |
| `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | Sentry environment and release                                           |
| `SENTRY_AUTH_TOKEN`                    | Source map upload during the build, only when set                        |
