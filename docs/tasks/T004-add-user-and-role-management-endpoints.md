---
id: T004
title: Add user and role management endpoints
status: todo
epic: E41
depends: [T003]
estimate: 150000
specs:
  - docs/epics/41-website-api.md
  - docs/website/api-contract.md
---

## Goal

Admins manage staff accounts through RESTful endpoints, mapped with Mapperly, with an audit trail.

## Scope

/api/v1/users: GET for a paged list with search, POST to invite, GET /{id}, PATCH /{id} for name, roles and the disabled flag, and DELETE /{id}. Admin-only password resets and two-factor resets as api-contract.md shapes them. An invitation flow that returns a one-time setup link (24 hours, single use, stored as a hash) and an acceptance endpoint that sets the password. All Admin only, and the last Admin can never be removed or demoted. Mapperly mappers for the user DTOs. An AuditEntry entity (actor id, action, target, time) written for every user change.

## Acceptance criteria

- [ ] An Editor gets 403 on every /api/v1/users route except /me
- [ ] Creating a user returns 201 with a Location header and a one-time link that works once and expires after 24 hours
- [ ] Removing or demoting the last Admin returns 409 problem details
- [ ] The list supports page, pageSize (at most 100) and q, and returns the paging metadata from api-contract.md
- [ ] Every change writes an audit entry, and no user DTO carries a password hash, security stamp or token

## Test plan

Write integration tests first for each route and rule. Add unit tests for the Mapperly mappers, including one that fails when a sensitive property appears in the output. Then run pnpm website-api:test.
