---
id: T003
title: Add ASP.NET Core Identity on long keys with cookie sign-in
status: done
epic: E41
depends: [T002]
estimate: 180000
specs:
  - docs/epics/41-website-api.md
  - docs/website/api-contract.md
---

## Goal

Staff sign in to the website API with Microsoft Identity, and every identity table uses bigint keys.

## Scope

In Runova.Website.Data: AppUser : IdentityUser<long>, AppRole : IdentityRole<long>, an IdentityDbContext<AppUser, AppRole, long> on Npgsql, and the first migration. Seed the roles Admin and Editor. Add a deny-by-default fallback authorization policy and cookie authentication (HttpOnly, Secure, SameSite=Strict, 8-hour sliding expiry), with antiforgery on unsafe methods. Lock an account after 5 failures and require passwords of 12 or more characters. Add TOTP two-factor with recovery codes. Add the endpoints from api-contract.md: POST /api/v1/sessions, DELETE /api/v1/sessions/current, GET /api/v1/users/me, and two-factor setup and confirm under /api/v1/users/me/two-factor. Add a CLI verb, admin create-owner, that reads the password from stdin to create the first Admin. No public sign-up. User management comes in T004.

## Acceptance criteria

- [ ] The migration creates AspNetUsers and AspNetRoles with bigint Id columns, checked through information_schema
- [ ] Sign-in with the right password returns 204 and sets the cookie; a wrong password returns 401 problem details; the sixth failure locks the account
- [ ] With two-factor on, sign-in needs a valid TOTP code, and each code works only once
- [ ] Any endpoint not marked anonymous answers 401 without a cookie, and an unsafe request without the antiforgery token answers 400
- [ ] admin create-owner creates an Admin from stdin and refuses to run when an Admin already exists

## Test plan

Write integration tests against Testcontainers PostgreSQL before the code: identity key column types, sign-in success, failure and lockout, two-factor, sign-out, the fallback policy, antiforgery, and the CLI verb. Then run pnpm website-api:test.
