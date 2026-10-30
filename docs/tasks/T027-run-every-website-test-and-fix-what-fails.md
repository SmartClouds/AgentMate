---
id: T027
title: Run every website test and fix what fails
status: todo
epic: E40
depends: [T021, T025, T026]
estimate: 220000
specs:
  - docs/epics/40-website.md
  - docs/epics/41-website-api.md
  - docs/website/api-contract.md
---

## Goal

The whole website, front and back, is green with no test skipped or weakened.

## Scope

In the worktree, run pnpm website-api:format:check, website-api:build and website-api:test; in apps/website/web, bun run lint, check, test, build, e2e and Lighthouse CI; and the compose full-stack spec. Fix each failure at its cause, never by skipping, weakening or deleting a test. Check the endpoints against api-contract.md (verbs, status codes, plural nouns, problem details) with a test over the OpenAPI document, and review the ingest and admin endpoints for security: auth on every write, no secret in logs, Sentry or OpenTelemetry output.

## Acceptance criteria

- [ ] Every website gate listed in the scope passes in one clean run
- [ ] A test over the OpenAPI document fails on any path that is not a plural noun under /api/v1 or any error response that is not problem details
- [ ] No secret, cookie or signature value appears in captured logs, Sentry events or spans during the full-stack spec
- [ ] Every fix comes with a test that failed before it

## Test plan

Write the OpenAPI convention test and the secret leak check first. Then run every gate in the scope, fix and rerun until all pass, and record the final counts in the handoff.
