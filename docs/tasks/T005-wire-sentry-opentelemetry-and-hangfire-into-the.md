---
id: T005
title: Wire Sentry, OpenTelemetry and Hangfire into the API
status: todo
epic: E41
depends: [T004]
estimate: 160000
specs:
  - docs/epics/41-website-api.md
---

## Goal

Errors reach Sentry, traces, metrics and logs go out over OpenTelemetry, and background jobs run on Hangfire with PostgreSQL storage.

## Scope

Sentry.AspNetCore: DSN from config, environment and release set, PII off, and cookies, Authorization and X-Runova-* headers scrubbed. OpenTelemetry tracing, metrics and logging through the OTLP exporter, with ASP.NET Core, HttpClient, Npgsql and EF Core instrumentation, linked to Sentry. Hangfire with Hangfire.PostgreSql in its own schema, a registry class for recurring jobs, and the dashboard at /hangfire for Admins only. One recurring job that deletes expired invitations from T004. Settings come from environment variables, and an empty DSN or OTLP endpoint breaks nothing.

## Acceptance criteria

- [ ] An unhandled exception in a request is captured with the request's trace id and without any cookie, Authorization or X-Runova-* header value
- [ ] A request produces an ASP.NET Core span with an EF Core child span in an in-memory exporter
- [ ] The API starts and serves requests with no Sentry DSN and no OTLP endpoint set
- [ ] /hangfire answers 401 when signed out, 403 for an Editor and 200 for an Admin
- [ ] The cleanup job deletes only expired invitations

## Test plan

Write tests first: a fake Sentry transport that captures events, an in-memory OpenTelemetry exporter, the dashboard authorization, and the cleanup job run directly against Testcontainers PostgreSQL. Then run pnpm website-api:test.
