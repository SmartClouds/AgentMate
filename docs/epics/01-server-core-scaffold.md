# E01 Server core scaffold

Milestone: M1 Foundations. Depends on: E00.

## Goal

A .NET 10 solution for the server core lives in `apps/server-core`, builds and tests in CI, serves
an anonymous health endpoint and an authenticated SignalR hub, and publishes its contracts to
TypeScript through Tapper and TypedSignalR.Client.TypeScript with a drift check. From this epic
on, nothing in the core is reachable without an explicit authorization decision.

## Tasks

- [x] T1 Solution layout: `Runova.ServerCore.slnx`, `global.json` (SDK 10.0.4xx, roll forward
  latest feature, Microsoft.Testing.Platform runner), `Directory.Build.props` (nullable, implicit
  usings, warnings as errors, latest analyzers, invariant globalization), `Directory.Packages.props`
  (central versions), `packages.lock.json` per project with locked restore in CI, `nuget.config`
  with package source mapping to nuget.org only, `.editorconfig` for C#, a local dotnet tool
  manifest pinning the TypedSignalR generator.
- [x] T2 Projects: `src/Runova.ServerCore` (web host, `serve` and `admin` commands, runtime
  identifiers `linux-x64;linux-arm64` so locked publishes work), `tests/Runova.ServerCore.Tests`
  (xUnit v3), `tests/Runova.ServerCore.SystemTests` (placeholder that skips outside Linux with
  Docker; CI runs it only in the `[e2e]` job that E03 adds).
- [x] T3 Host: minimal APIs; host filtering and rejection of any request with an `Origin` header
  before authentication; a placeholder authentication scheme that never authenticates and
  challenges with 401 (E04 replaces it); authorization with a deny-by-default fallback policy;
  `GET /api/v1/health` marked anonymous (status, version, API version); Kestrel limits; listening
  on a Unix socket in production (stale socket files from a crash are detected and replaced, the
  socket ends up 0660) and on loopback TCP in development. Only an exact first argument of `admin`
  diverts from the web host, and nothing with side effects runs before the host is built.
- [x] T4 `runova-core admin version` prints the version as JSON without starting Kestrel (the
  installer uses it later).
- [x] T5 Contracts: `[TranspilationSource]` DTOs (Tapper attributes) and the `[Hub]` `ICoreHub` and
  `[Receiver]` `ICoreHubReceiver` interfaces (TypedSignalR attributes); `CoreHub` implements
  `ICoreHub` and is mapped at `/hubs/core` behind an explicit policy; JSON options (camelCase,
  omit nulls, camelCase string enums) shared by REST and the hub.
- [x] T6 Generation: `dotnet tsrts` (pinned local tool) writes the TypeScript into
  `apps/desktop/src/shared/deploy/protocol/generated/`; root script `server-core:contracts`
  regenerates it; the folder is excluded from Biome and pinned to LF in `.gitattributes`; the
  desktop typecheck (`tsc` 7) compiles it.
- [x] T7 Drift check: CI regenerates the contracts and fails when `git diff` shows any change; a
  .NET test fails when a hub method has no authorization attribute or the hub stops implementing
  its interface.
- [x] T8 A reflection test fails if any endpoint lacks an explicit authorization decision.
- [x] T9 Root scripts `server-core:build`, `server-core:test`, `server-core:format`,
  `server-core:contracts`; `.gitignore` gains `apps/server-core/**/bin/`, `obj/` and `artifacts/`;
  `.gitattributes` pins `*.cs`, `*.csproj`, `*.props`, `*.slnx`, `*.sh`, systemd units and the
  generated contracts to LF; Biome ignores `apps/server-core/**` and the generated folder.
- [x] T10 CI: a `server-core` job in `test.yml` (setup-dotnet from `global.json`, locked restore,
  `dotnet format --verify-no-changes`, build, tests of the Tests project only, NuGet audit failing on
  high or critical, contracts drift check) that is part of the `all-green` gate in `ci.yml`.
- [x] T11 README: project structure and scripts mention `apps/server-core`.

## Acceptance criteria

1. `dotnet test` passes locally and in CI; the new job is part of the green gate.
2. The health endpoint answers anonymously; an unknown route, a real non-health route and the hub
   negotiate endpoint all return 401 (tested).
3. A request with an `Origin` header or an unknown Host is refused before authentication (tested).
4. The generated TypeScript compiles under `tsc` 7 as part of the desktop typecheck.
5. Changing a contract without regenerating fails the drift check.
6. `admin version` returns without starting Kestrel, and the web host still boots under the test
   factory (tested).
7. On Linux, the host starts even when a stale socket file exists, and the socket ends up 0660
   (tested, skipped on other platforms).

## Implementation notes

- **Contract generation.** The plan first named `openapi-typescript`. It, and `@hey-api/openapi-ts`,
  print through the TypeScript 5 compiler API, which TypeScript 7 no longer ships (verified: hey-api
  crashes on `ts.SyntaxKind`). Kiota works but types every field as optional. The user chose
  Tapper plus TypedSignalR.Client.TypeScript, which read the C# contracts directly; the API became
  WebSocket-first, and OpenAPI generation was dropped. The roadmap records the decision.
- **Where the TypeScript lives.** The generator emits extensionless relative imports, which
  `packages/core` (NodeNext) rejects, so the output goes to
  `apps/desktop/src/shared/deploy/protocol/generated` (Bundler resolution), shared by main and
  renderer, excluded from coverage and Biome.
- **Nulls.** Tapper types a nullable C# member as an optional TypeScript field, so the core's JSON
  omits nulls (`WhenWritingNull`) and the wire matches the types. TypedSignalR drops the
  nullability of hub method parameters, so hub methods should take request records rather than
  nullable parameters.
- **The generator needs a restored project** (it loads it through MSBuild), so
  `server-core:contracts` restores first. Linux and Windows produce byte-identical output
  (checked with SHA-256 in the .NET SDK container).
- **Placeholder authentication.** The scheme is named `RunovaDevice`; its handler
  (`NoCredentialsAuthenticationHandler`) authenticates nobody so challenges are a clean 401 until
  E04 replaces it.
- **Invariant globalization.** The core accepts ASCII (punycode) domain labels only; the desktop
  converts international names with `url.domainToASCII` before sending them.
- **Stale sockets.** .NET unlinks a Unix socket's file when the socket is disposed, so the crash
  simulation in the tests binds through raw libc calls. Kestrel's listen callback clears a stale
  file at server start (never one a live process serves), and the 0660 mode is applied after start
  only to addresses Kestrel really bound.
- **XML comments cannot contain two hyphens in a row**, which silently broke restore once
  (`Directory.Build.props`).
- **Local Biome runs.** This Windows checkout uses `core.autocrlf=true`, so a full-repo
  `biome ci` flags CRLF in untouched files locally; CI checks out LF. Run Biome on changed files
  locally.

