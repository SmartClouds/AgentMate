# E40 reCAPTCHA keys

Milestone: standalone (Deploy). Depends on: E14 (the Cloudflare page, whose account-level place in
Deploy this shares), E28 (the loopback OAuth sign-in, lifted out of server backups here), E10 (the
nginx sites whose domains are suggested).

## Goal

A person gets reCAPTCHA keys for their sites without opening the Google Cloud console. They sign in
with Google once, pick a Google Cloud project (or let Runova make one), and from then on a key for a
site takes a few seconds: its domains come from the sites Runova knows, and the site key, the secret
and code to paste are shown right away. Every key stays manageable from the page: edit, delete, read
the secret again, see this month's checks against Google's free allowance.

## Design

- **Google's API, not the old admin console.** The classic console at google.com/recaptcha/admin has
  no API. The reCAPTCHA (Enterprise) REST API does everything here: `projects.keys` create, list,
  patch (with `updateMask`), delete, `retrieveLegacySecretKey` and `getMetrics`. Resource Manager v3
  lists and creates projects, and Service Usage turns the reCAPTCHA API on. All three are long-running
  operations polled with a backoff where Google says so.
- **The legacy secret.** `retrieveLegacySecretKey` gives a secret that works with the classic
  `siteverify` endpoint, so the code people already have keeps working. It is read from Google only
  when the user asks (or right after a key is made) and never stored.
- **Sign-in.** OAuth with PKCE over a loopback redirect, the flow server backups already used, now in
  `main/oauth/loopback.ts` for any provider and returning every token. Scopes are
  `openid email https://www.googleapis.com/auth/cloud-platform`: reCAPTCHA's API takes nothing
  narrower. `prompt=select_account consent` lets a person with several accounts pick one and makes
  Google hand out a refresh token each time.
- **Whose OAuth client.** Runova's own Desktop client, read at build time from
  `MAIN_VITE_GOOGLE_CLIENT_ID` and `MAIN_VITE_GOOGLE_CLIENT_SECRET` (a Desktop client's secret is not
  confidential to Google), for a one-click sign-in. The user's own client is the fallback, folded
  under "Use my own OAuth client", and the only way in a build without Runova's.
- **At rest.** `google-cloud.json` beside the other stores holds each account: the email, which client,
  the sealed refresh token (and the sealed client secret for the user's own client), the last project
  and whether Google refused the sign-in. Sealed with the Servers vault and moved on a passkey change,
  like Cloudflare's tokens. Nothing that leaves the main process carries a token or an envelope.
- **Access tokens** live in memory only (`GoogleTokens`), renewed a minute before they run out, one
  renewal shared by every waiting call. `invalid_grant` marks the account so the page offers
  "Sign in again"; signing in again as the same person keeps the account and its project.
- **Billing header.** reCAPTCHA calls send `x-goog-user-project` with the user's project, so they count
  against it and not Runova's OAuth project. Resource Manager and Service Usage calls do not, so
  Runova's OAuth project needs those two APIs (and reCAPTCHA) turned on.
- **Errors in words, with a code for each fix.** `[recaptcha:code]` tags (as with Cloudflare):
  `locked` (unlock), `reauth` (sign in again), `no-account`, `api-disabled` (turn it on), `permission`
  (names the role), `quota` and `not-found`. An API that is off in the OAuth client's own project is
  named, with Google's activation link. Anything shaped like a Google token is scrubbed from messages.
- **Domains** are checked with one rule set on both sides (`shared/recaptcha/domains.ts`): pasted URLs,
  ports, paths and `*.` are trimmed to the bare host, IDN becomes punycode, IP addresses are refused,
  `localhost` has its own switch, at most 250 per key.
- **The page.** An account-level page like Cloudflare's (`?recaptcha=1`, a row in the server rail, and
  `deploy/recaptcha`), never a dialog on top for the steps. Signed out: a short welcome with Google's
  own branded sign-in button. Then a project picker with "Create a project for me" first and a
  checklist that follows the setup as the main process reports it. Then a usage meter and the keys.
  A site in the Websites section links to the page with a new key filled in (`newKey=`, `label=`).
- **Suggestions** come only from what the app has already loaded (servers' nginx sites, WordPress
  sites, Cloudflare zones), so opening the dialog never signs in to a server.
- **Usage** is this month's daily score buckets summed across the project's keys, read as Pacific
  dates as Google counts them. The allowance (10,000 a month) is per Google organization, which the
  page says.

## Tasks

- [x] T1 Loopback OAuth for any provider, returning every token; server backups keep their behaviour.
- [x] T2 Shared domain rules and the snippet generators (HTML, React, PHP and Node.js checks).
- [x] T3 The sealed account store and access token renewal; Runova's client from the build.
- [x] T4 The REST client over the three APIs, operation polling, and the error mapping.
- [x] T5 `RecaptchaService`: sign-in for both client kinds, project setup with progress, keys, usage.
- [x] T6 IPC with argument checks, preload, and the wiring in `main/deploy/index.ts`.
- [x] T7 Navigation: rail row, address, remembered selection, empty-state button, deep link.
- [x] T8 The page: sign-in, own client, locked vault, lapsed sign-in, project picker and setup.
- [x] T9 The keys card: rows, copy, secret on request, search and filter, delete, failures with fixes.
- [x] T10 The key dialog: site suggestions, type cards, domain chips, difficulty, ready panel, edit.
- [x] T11 The usage meter.
- [x] T12 End to end against a Google fake on loopback (`e2e/recaptcha.e2e.ts`).
- [x] T13 Help article (`deploy-recaptcha.md`), these docs and coverage thresholds.

## Acceptance criteria

- AC1 A signed-out user reaches a working key in four clicks with Runova's client: sign in, create a
  project, create your first key, create key.
- AC2 The refresh token and the user's client secret never reach the renderer, never show on screen
  and never reach the disk unsealed.
- AC3 A secret is read from Google only on request (or right after the key is made).
- AC4 Every failure the page has a fix for shows that fix: unlock, sign in again, turn reCAPTCHA on,
  the role to ask for, or try again.
- AC5 Domains the user types or pastes reach Google only as bare domains Google accepts.
- AC6 A site's "Protect with reCAPTCHA" opens the create dialog with its domains filled in.

## Known limits

- **Not tried against the real Google yet.** Everything was built against Google's REST reference and
  checked with fakes (unit tests and a loopback Google in e2e). A smoke test with a real account in
  own-client mode is still to do: sign in, create a project, create a key, verify a token from the
  HTML snippet against `siteverify` with the secret, edit and delete.
- **Runova's own Google client does not exist yet.** It needs a Google Cloud project with the consent
  screen (External; scopes `openid`, `email`, `cloud-platform`; privacy policy and home page URLs), a
  Desktop client, the Resource Manager, Service Usage and reCAPTCHA Enterprise APIs turned on, and
  the two `MAIN_VITE_` values in CI. `cloud-platform` is a sensitive scope, so until Google verifies
  the app users see an "unverified app" screen and the client is capped at 100 users.
- Only website keys are listed; Android, iOS and Express keys in the same project are left out.
- The policy-based challenge type, IP overrides, WAF settings and assessments are not offered.
- Usage is per project; the free allowance is shared across the Google organization.
