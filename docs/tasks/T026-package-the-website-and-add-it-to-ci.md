---
id: T026
title: Package the website and add it to CI
status: todo
epic: E40
depends: [T010, T022]
estimate: 190000
specs:
  - docs/epics/40-website.md
  - docs/epics/41-website-api.md
---

## Goal

The site and the API run together the way production will, and CI tests them on every push.

## Scope

Dockerfiles for the API (multi-stage, .NET 10 chiseled runtime, non-root) and the web (oven/bun image, non-root, bun runtime). apps/website/compose.yaml with PostgreSQL 18, the API (migrations on start behind a flag), the web, and a reverse proxy that routes /api, /media and /hangfire to the API on one origin. Jobs in .github/workflows/ci.yml: website-api (format check, build, and tests with Testcontainers on Linux) and website-web (bun install --frozen-lockfile, lint, astro check, test, build, Playwright e2e and Lighthouse CI against the compose stack), both counted by the existing all-green job. A full-stack Playwright spec: an API client signs a news POST, and the item appears on /news and in GET /api/v1/news.

## Acceptance criteria

- [ ] docker compose up on apps/website/compose.yaml serves the site, the API and /hangfire on one origin with no manual step
- [ ] Both images run as a non-root user and the API image has no SDK
- [ ] The full-stack spec passes against the compose stack
- [ ] The new CI jobs pass in a workflow run and are required by all-green

## Test plan

Write the full-stack Playwright spec first and see it fail. Then build the images and compose stack until it passes locally. Then run the CI workflow (gh workflow run, or a push of the worktree branch if the user agrees) and read the job results.
