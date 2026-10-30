---
id: T011
title: Scaffold the Astro site on bun with the app's colors and fonts
status: done
epic: E40
depends: [T001]
estimate: 170000
specs:
  - docs/epics/40-website.md
  - docs/website/design.md
---

## Goal

An Astro site, installed and run with bun, that already looks like Runova and has the test tooling the page tasks need.

## Scope

apps/website/web, outside the pnpm workspace (apps/* only matches direct children), with bun as package manager and runtime and bun.lock committed. The latest stable Astro with @astrojs/react, @astrojs/mdx, @astrojs/sitemap, and the Node adapter run under bun for on-demand routes. Tailwind CSS 4, shadcn/ui set up for React islands, Fontsource fonts from design.md, and the design tokens for Dark (default) and Light, with a theme toggle that follows prefers-color-scheme and remembers the choice. A base layout with header, footer and skip link, and an SEO head component (title template, description, canonical, Open Graph, Twitter card, JSON-LD slot). @sentry/astro configured from environment variables. Vitest with the Astro container API, Playwright e2e, the site's own biome.json, astro check, a dev proxy for /api to the API, and root scripts website:dev, website:build, website:test and website:e2e through scripts/website.mjs. Use the TypeScript version astro check supports (the TypeScript 7 rule covers the desktop app and packages). Only a placeholder home page.

## Acceptance criteria

- [ ] bun install --frozen-lockfile, bun run lint, bun run check, bun run test and bun run build all pass
- [ ] bun run start serves the built site under the bun runtime
- [ ] A test reads apps/desktop/src/renderer/src/index.css and fails if any site color token differs from the app's
- [ ] The SEO head renders a canonical URL, Open Graph and Twitter tags and a JSON-LD script (container test)
- [ ] With prefers-reduced-motion set, no animation or transition runs (Playwright check of computed styles)
- [ ] pnpm ls at the root does not list the site as a workspace package

## Test plan

Write first: the token parity test, container tests for the SEO head and layout, and a Playwright test for the theme toggle and reduced motion. Then run bun run lint, check, test, build and e2e in apps/website/web.
