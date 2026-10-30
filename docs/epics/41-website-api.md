# E41: Website API

The .NET 10 API behind the website: staff sign-in, news, the blog, media, API clients that publish
with signed requests, and the latest desktop release. Related specs: [E40W Website](40-website.md)
(architecture, routes and working rules), [E42 Dashboard news](42-dashboard-news.md) and the
[API contract](../website/api-contract.md), which is the source of truth for every endpoint, DTO,
status code and the signing scheme. This file says how the API is built; the contract says what it
answers.

## Solution layout

```text
apps/website/api/
  Runova.Website.slnx
  global.json                    SDK 10.0.401, rollForward latestPatch, Microsoft.Testing.Platform
  Directory.Build.props          shared settings (below)
  Directory.Packages.props       every package version, central and transitive pinning
  .editorconfig                  copied from apps/server-core, then kept in step by hand
  src/
    Runova.Website.Api/          host: Program.cs, endpoint groups, auth handlers, middleware,
                                 Hangfire registration, the admin CLI verbs
    Runova.Website.Core/         domain types, services, validation rules, Mapperly mappers,
                                 the version range parser, the signing canonicalizer
    Runova.Website.Data/         AppDbContext, entity configurations, migrations
  tests/
    Runova.Website.Tests/        unit tests (no database, no network)
    Runova.Website.IntegrationTests/
                                 WebApplicationFactory over Testcontainers PostgreSQL
```

References point inward only: Api references Core and Data, Data references Core, Core references
nothing of ours. Each project has a `packages.lock.json`, committed.

`Directory.Build.props` follows `apps/server-core/Directory.Build.props`: `net10.0`, `LangVersion`
latest, nullable and implicit usings on, `TreatWarningsAsErrors`, `AnalysisLevel`
latest-recommended, `EnforceCodeStyleInBuild`, deterministic builds, `InvariantGlobalization` (the
site is English only and the chiseled image has no ICU), `RestorePackagesWithLockFile` with locked
mode on CI, and NuGet audit over all packages at level low with only `NU1900` to `NU1902` kept as
warnings. `Directory.Packages.props` uses `ManagePackageVersionsCentrally` and
`CentralPackageTransitivePinningEnabled`, grouped by labelled `ItemGroup`s with a comment on any
package whose choice is not obvious.

Root scripts (`scripts/website-api.mjs`, called from the root `package.json`):
`website-api:build` (`dotnet build -c Release`), `website-api:test` (`dotnet test` through
Microsoft.Testing.Platform), `website-api:format` and `website-api:format:check`
(`dotnet format --verify-no-changes`).

## Packages

Each task adds the packages it needs at their latest stable version. The set, by area:

| Area | Packages |
|---|---|
| Data | `Npgsql.EntityFrameworkCore.PostgreSQL`, `Microsoft.EntityFrameworkCore.Design` (design time only) |
| Identity | `Microsoft.AspNetCore.Identity.EntityFrameworkCore` |
| OpenAPI | `Microsoft.AspNetCore.OpenApi` (built in), `Scalar.AspNetCore` (reference page) |
| Mapping | `Riok.Mapperly` |
| Content | `Markdig`, `HtmlSanitizer` |
| Images | `SixLabors.ImageSharp` (decode, strip metadata, re-encode) |
| Jobs | `Hangfire.Core`, `Hangfire.AspNetCore`, `Hangfire.PostgreSql` |
| Errors and telemetry | `Sentry.AspNetCore`, `Sentry.OpenTelemetry`, `OpenTelemetry.Extensions.Hosting`, `OpenTelemetry.Exporter.OpenTelemetryProtocol`, `OpenTelemetry.Instrumentation.AspNetCore`, `OpenTelemetry.Instrumentation.Http`, `OpenTelemetry.Instrumentation.EntityFrameworkCore`, `Npgsql.OpenTelemetry` |
| Tests | `xunit.v3`, `Microsoft.AspNetCore.Mvc.Testing`, `Testcontainers.PostgreSql`, `Verify.XunitV3`, `Microsoft.Extensions.TimeProvider.Testing`, `Respawn` |

A package outside this list is fine when a task needs it, under the package rule in
[E40W](40-website.md#working-rules).

## Host conventions

- **Minimal APIs.** One static class per resource (`NewsEndpoints.MapNews(RouteGroupBuilder)`) on
  the `/api/v1` route group, returning `TypedResults` so the OpenAPI document knows every response.
  Route constraints: `{id:long}` and `{slug:regex(...)}` as the contract describes.
- **Problem details.** `AddProblemDetails` plus an exception handler and status code pages, so every
  error, including a 404 for an unknown route and a 405, is `application/problem+json` with the
  `type` URIs and extensions from the contract. Unhandled exceptions answer `internal` without any
  detail outside Development.
- **Validation.** The built-in .NET 10 minimal API validation (`AddValidation` with data annotations
  and `IValidatableObject` on the request DTOs), plus rules that need the database (unique slugs,
  known technology slugs) in the service, all reported in the same `errors` shape. Unknown JSON
  properties are refused (`JsonUnmappedMemberHandling.Disallow`).
- **JSON.** `System.Text.Json` with camelCase, enums as the contract's lowercase strings (a
  `JsonStringEnumConverter` with a kebab-case lower naming policy), and times as UTC with
  milliseconds.
- **Time.** Code reads time only from an injected `TimeProvider`, so tests use
  `FakeTimeProvider`.
- **OpenAPI.** `MapOpenApi()` at `/openapi/v1.json`; `MapScalarApiReference()` at `/scalar` in
  Development and Staging only. A Verify snapshot test fails on any unplanned change to the
  document, and T027 adds a test over it for plural paths and problem details responses.
- **Health.** `/health/live` (no checks) and `/health/ready` (a PostgreSQL check), both anonymous
  and outside `/api/v1`.
- **Forwarded headers.** The API trusts `X-Forwarded-For` and `X-Forwarded-Proto` only from the
  reverse proxy's network (`Website__KnownProxies`), so rate limits and IP allowlists see the real
  client address.
- **Rate limiting.** The built-in rate limiter with the partitions from the contract (per IP for
  sign-in and anonymous reads, a token bucket per API client).

## Data

- `AppDbContext : IdentityDbContext<AppUser, AppRole, long>` on Npgsql. Every key is `bigint`
  (`long`) generated by an identity column, Identity tables included.
- Table and column names stay EF Core's defaults (`AspNetUsers`, `NewsItems`), so the Identity
  tables keep their usual names.
- Concurrency: every editable entity maps PostgreSQL's `xmin` as its row version
  (`IsRowVersion()`), which is what the ETag and `version` come from.
- Times are `timestamp with time zone`, stored in UTC.
- Arrays that are only read with their row (CVE ids, tags on news, scopes, the IP allowlist) are
  PostgreSQL arrays; affected technologies are an owned collection in their own table so the
  `technology` filter can use an index. Full-text search uses a generated `tsvector` column with a
  GIN index.
- Migrations live in Runova.Website.Data. The API applies them on start only when
  `Database__MigrateOnStart=true` (compose sets it); otherwise `dotnet ef database update` or the
  `admin migrate` verb.
- Seed data in migrations is limited to the roles and the technology list. Test data is created by
  the tests.

## Identity and authorization

- `AppUser : IdentityUser<long>` adds `DisplayName`, `CreatedAt` and `DisabledAt`.
  `AppRole : IdentityRole<long>`. Roles `Admin` and `Editor` are seeded; there is no public sign-up.
- Passwords: at least 12 characters, no other composition rules, checked against the
  `PasswordHasher` defaults. Lockout after 5 failures for 15 minutes, for new users too.
- Two-factor: TOTP through the Identity authenticator token provider, 10 recovery codes, each code
  usable once (the last accepted time step is stored per user).
- Cookie: `__Host-runova-session`, HttpOnly, Secure, SameSite=Strict, 8-hour sliding expiry,
  security stamp validated every 5 minutes so a disabled user or reset two-factor ends sessions.
  API calls never redirect: an unauthenticated call answers 401 and a forbidden one 403, both as
  problem details.
- Antiforgery: `AddAntiforgery` with the header `X-XSRF-TOKEN`, required on every unsafe method that
  came with the cookie; signed requests skip it.
- Schemes: the Identity cookie and `RunovaSignature` (T008). A policy scheme picks
  `RunovaSignature` when an `X-Runova-Key-Id` header is present, else the cookie.
- Policies: the fallback policy requires an authenticated user, so an endpoint is anonymous only
  when it says `AllowAnonymous`. Named policies `Staff` (Admin or Editor), `Admin`, `NewsWrite`
  (Staff, or a client with scope `news:write`) and `PostsWrite` (Staff, or `posts:write`).
- Admin CLI verbs, run as `dotnet Runova.Website.Api.dll admin <verb>` before the web host starts:
  `create-owner --email <e> --name <n>` (password read from stdin, refuses when any Admin exists)
  and `migrate`.
- Every change to users, roles, API clients, news and posts writes an `AuditEntry` (actor kind and
  id, action, target type and id, time, and a small JSON of what changed with secrets left out).

## Mapping

Riok.Mapperly mappers live in Runova.Website.Core, one `[Mapper]` partial class per resource, with
`RequiredMappingStrategy = Target` so a new DTO property without a source fails the build. Mapping
to DTOs never includes password hashes, security stamps, tokens, secret hashes or signing keys; a
unit test per mapper fails when a property with one of those names appears in its output.

## Content

Markdown is rendered with Markdig (advanced extensions without raw HTML pass-through) and the result
is cleaned with HtmlSanitizer, set up once and shared by news and posts: no `script`, `iframe`,
`object`, `embed`, `form`, `style` attributes, event handler attributes or `javascript:` URLs;
external links get `rel="noopener noreferrer nofollow"`. The rendered HTML is stored with the item
and re-rendered when the body changes.

Media uploads are sniffed from their first bytes (PNG, JPEG, WebP, AVIF), decoded and re-encoded
with ImageSharp to drop EXIF and every other metadata block, and stored under
`Website__MediaPath` with a random file name. The reverse proxy, or the API's static file
middleware in development, serves them at `/media/`.

## Observability

- **Sentry.** `Sentry.AspNetCore` with `Sentry__Dsn`, `Sentry__Environment` and `Sentry__Release`
  (the image's version). `SendDefaultPii` is off. A `SetBeforeSend` hook removes cookies, the
  `Authorization` header and every `X-Runova-*` header value from events and breadcrumbs. An empty
  DSN disables Sentry and changes nothing else.
- **OpenTelemetry.** Tracing, metrics and logging through the OTLP exporter, configured by the
  standard `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME`
  (default `runova-website-api`). Instrumentation for ASP.NET Core, HttpClient, Npgsql and EF Core,
  with SQL statement text left out of spans. `Sentry.OpenTelemetry` links errors to traces. No
  endpoint set: nothing is exported and nothing fails.
- **Logs.** Structured logging only. Request and response bodies are never logged; header values
  from cookies, `Authorization` and `X-Runova-*` are redacted in HTTP logging.

## Background jobs

Hangfire on PostgreSQL (`Hangfire.PostgreSql`) in the schema `hangfire`, prepared on start. One
class, `RecurringJobRegistry`, registers every recurring job by a fixed id, so a job's schedule is
in one place and a test can list them:

| Job id | Schedule | Does | Task |
|---|---|---|---|
| `invitations-cleanup` | hourly | Deletes expired invitations | T005 |
| `news-publish` | every minute | Publishes scheduled news and posts whose `publishedAt` has arrived | T007, T009 |
| `signature-nonces-purge` | every 10 minutes | Deletes nonces older than the clock skew window | T008 |
| `idempotency-purge` | hourly | Deletes idempotency records older than 24 hours | T008 |
| `releases-sync` | every 15 minutes | Reads the latest GitHub release with `If-None-Match` | T010 |

Jobs take their time from `TimeProvider` and are plain classes, so tests run them directly without a
Hangfire server. The dashboard is mapped at `/hangfire` with
`MapHangfireDashboard(...).RequireAuthorization("Admin")` and no Hangfire authorization filters of
its own, so ASP.NET Core answers 401 signed out and 403 for an Editor.

## Configuration

Settings come from environment variables (double underscore for sections). Secrets never sit in
`appsettings.json`.

| Variable | Meaning |
|---|---|
| `ConnectionStrings__Default` | PostgreSQL connection string |
| `Database__MigrateOnStart` | `true` to apply migrations on start |
| `Website__SiteUrl` | Public origin, used for `url` fields and invitation links |
| `Website__MediaPath` | Folder for uploaded media |
| `Website__KnownProxies` | Proxy networks trusted for forwarded headers |
| `GitHub__Token` | Optional token for the release sync (raises GitHub's rate limit) |
| `Sentry__Dsn`, `Sentry__Environment`, `Sentry__Release` | Sentry |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` | OpenTelemetry |

Data Protection keys (which seal API client signing keys) are persisted to PostgreSQL through
`PersistKeysToDbContext`, so every API instance can read them.

## Testing

- xunit v3 on Microsoft.Testing.Platform, as in apps/server-core.
- Unit tests in Runova.Website.Tests: mappers, the version range parser, the canonical string and
  signature against the contract's test vectors, the Markdown renderer and sanitizer, asset
  classification over recorded release JSON, filter query building.
- Integration tests in Runova.Website.IntegrationTests: one PostgreSQL container per test assembly
  (`Testcontainers.PostgreSql`, the official `postgres` image at the major version compose uses),
  `WebApplicationFactory<Program>` pointed at it, Respawn to reset data between tests, and
  `FakeTimeProvider` for anything time based. GitHub is a fake `HttpMessageHandler`; Sentry is a
  fake transport; OpenTelemetry uses the in-memory exporter.
- The C# reference signing client lives in the integration test project and the TypeScript one in
  `docs/website/examples/`; both are checked against the test vectors.
- Integration tests need Docker. CI runs them on Linux (T026); on a machine without Docker they fail
  with a clear message rather than being skipped silently.

## Tasks

| Task | Adds |
|---|---|
| T002 | Solution, conventions, problem details, OpenAPI and Scalar, health, sample mapper |
| T003 | Identity on long keys, sessions, two-factor, the admin CLI |
| T004 | Users, invitations, audit entries |
| T005 | Sentry, OpenTelemetry, Hangfire and its dashboard |
| T006 | News model and public reads, technologies |
| T007 | News writes and the publish job |
| T008 | API clients and signed requests |
| T009 | Blog posts, tags and media |
| T010 | Latest desktop release from GitHub |
