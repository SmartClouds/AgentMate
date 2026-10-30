---
id: T008
title: Add API clients and signed requests for writing news from other systems
status: todo
epic: E41
depends: [T007]
estimate: 190000
specs:
  - docs/epics/41-website-api.md
  - docs/website/api-contract.md
---

## Goal

Another system can publish news through the same news resource, authenticated by a long secret and a signed request.

## Scope

An ApiClient entity: long id, name, public key id, secret hash, scopes (news:write, posts:write), optional IP allowlist, expiresAt, revokedAt and lastUsedAt. Admin endpoints under /api/v1/api-clients: GET, POST (returns a 256-bit secret once), GET /{id}, PATCH, and DELETE to revoke. POST /api/v1/api-clients/{id}/secrets rotates the secret with an overlap window. A RunovaSignature authentication handler per api-contract.md: HMAC-SHA256 over method, path and query, timestamp, nonce and the body's SHA-256, a 5-minute clock skew, nonces stored and refused on replay, and a constant-time compare. Scope-based policies on the news write endpoints, per-client rate limiting, Idempotency-Key on POST, a Hangfire job that purges old nonces, and audit entries. A reference signing client in C# (in the test project) and one in TypeScript under docs/website/examples.

## Acceptance criteria

- [ ] The test vector in api-contract.md verifies with both reference clients and with the handler
- [ ] A bad signature, an old timestamp, a reused nonce, a revoked or expired client, a disallowed IP or a missing scope is refused with 401 or 403 problem details that never say which check failed
- [ ] The secret appears only in the POST response and is stored only as a hash
- [ ] After rotation both secrets work until the overlap ends, then only the new one
- [ ] Repeating a POST with the same Idempotency-Key returns the first result and creates no second item
- [ ] Going over a client's rate limit returns 429 with Retry-After

## Test plan

Write these first: unit tests for the canonical string and signature against the test vector, and integration tests for every refusal case, rotation, idempotency and rate limiting through the C# reference client. Run the TypeScript example against the vector with bun. Then run pnpm website-api:test.
