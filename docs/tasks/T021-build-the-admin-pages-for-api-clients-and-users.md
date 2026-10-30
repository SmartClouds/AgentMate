---
id: T021
title: Build the admin pages for API clients and users
status: todo
epic: E40
depends: [T020]
estimate: 180000
specs:
  - docs/epics/40-website.md
  - docs/website/api-contract.md
---

## Goal

Admins manage the systems allowed to write news and the staff accounts, from the site.

## Scope

API clients: list, create (the secret shown once with a copy button and a warning), rotate, revoke, scopes and IP allowlist. Users: list, invite (copy the one-time link), roles, disable, and reset two-factor. A link to the Hangfire dashboard. These pages and their menu entries are for Admins only; Editors never see them. Destructive actions ask for confirmation.

## Acceptance criteria

- [ ] Creating an API client shows the secret once, and reopening the client never shows it again
- [ ] Rotating and revoking update the list, and a revoked client's signed request is refused (checked through the API)
- [ ] An Editor gets no menu entries and a 403 page on these routes
- [ ] Inviting a user produces a link that sets a password once, and the new user can sign in

## Test plan

Write component tests first for the one-time secret dialog and the confirmations. Then Playwright against the real API: an Admin creates, rotates and revokes a client (verified with the C# or TypeScript signing client from T008), invites a user who then signs in, and the same routes are blocked for an Editor.
