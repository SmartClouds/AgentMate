---
id: T002
title: Scaffold the website API solution on .NET 10
status: done
epic: E41
depends: [T001]
estimate: 140000
specs:
  - docs/epics/41-website-api.md
  - docs/website/api-contract.md
---

## Goal

A .NET 10 API skeleton that builds and has tests, ready for later tasks to add resources to.

## Scope

In the worktree, under apps/website/api: Runova.Website.slnx, global.json, and Directory.Build.props and Directory.Packages.props set up like apps/server-core (central versions, lock files, warnings as errors, NuGet audit). Projects: Runova.Website.Api (host and endpoints), Runova.Website.Core (domain, services, Mapperly mappers) and Runova.Website.Data (EF Core on Npgsql), plus tests Runova.Website.Tests (unit) and Runova.Website.IntegrationTests (WebApplicationFactory with Testcontainers PostgreSQL), on xunit v3 and Microsoft.Testing.Platform. Add RFC 9457 problem details for every error, the /api/v1 route group, the built-in OpenAPI document with a Scalar reference page, /health/live and /health/ready (with a database check), and Riok.Mapperly with one sample mapper. Add scripts/website-api.mjs with root scripts website-api:build, website-api:test, website-api:format and website-api:format:check, and add apps/website/** to Biome's ignore list. No Identity and no resources yet.

## Acceptance criteria

- [ ] pnpm website-api:build succeeds with warnings as errors
- [ ] GET /health/ready answers 200 against a Testcontainers PostgreSQL and 503 when the database is stopped
- [ ] An unknown /api/v1 route answers 404 with application/problem+json
- [ ] GET /openapi/v1.json is served and matches a snapshot test
- [ ] Every package is the latest stable version, pinned in Directory.Packages.props, with packages.lock.json committed
- [ ] pnpm biome:ci at the repo root still passes

## Test plan

Write these first: integration tests for health (database up and down), the problem details shape, and a Verify snapshot of the OpenAPI document, plus a unit test for the sample Mapperly mapper. Then run pnpm website-api:test and pnpm website-api:format:check.
