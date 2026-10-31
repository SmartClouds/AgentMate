# E43 Cloudflare Turnstile

Milestone: standalone (Deploy). Depends on: E14 (the Cloudflare page, its tokens and zone tabs),
E40 (the domain rules, snippet languages and key dialog layout shared with reCAPTCHA keys).

## Goal

A person gets a captcha for a site's forms from the Cloudflare page they already use, without
opening Cloudflare's dashboard. On a zone's **Turnstile** tab a widget for that domain takes a few
seconds: the name and domain are filled in, Managed is picked, and the site key, the secret and the
code to paste are shown right away. Every widget in the account stays manageable from there: edit,
rotate the secret, delete, read the secret again.

## Design

- **Cloudflare's API through the official SDK.** `turnstile.widgets` (`BaseWidgets`) gives list,
  create, get, update (PUT, the whole body each time), delete and `rotateSecret`. `get`, `create` and
  `rotateSecret` return the secret, the list does not.
- **An account API reached from a zone.** Widgets live under `/accounts/{id}/challenges/widgets`.
  Runova's account id is its own id for a saved token, so `listZones` now keeps Cloudflare's
  `zone.account.id` on each zone (`cloudflareAccountId`). Every Turnstile call takes a zone id: the
  service finds the token that holds the zone and the Cloudflare account it is in. No new permission
  is needed to learn the account.
- **The permission.** `Account > Turnstile > Edit` is a new extra permission (`turnstile`), named only
  when Cloudflare refuses a call, like SSL and Certificates and API Tokens. It never marks the main
  token report. Cloudflare's token template has no key for it, so the template link leaves it out and
  the help article says to add it by hand.
- **One rule set on both sides.** `shared/cloudflare/turnstile.ts` checks a widget (name up to 254
  characters, 1 to 10 bare domains with the reCAPTCHA domain rules, known mode, pre-clearance and
  region) in the dialog, in IPC and in the service, and knows a site key's shape and which widgets
  cover a zone (the zone itself or a subdomain of it).
- **The secret.** Read from Cloudflare only on request, never stored. The dialog puts the secret from
  `create` (and the rotate dialog the one from `rotateSecret`) into the query cache, so the next screen
  need not ask again. Secret queries sit apart from the list's key, so refreshing the list never reads
  a secret.
- **The tab.** Widgets for this domain first, with **All in account** one click away and a count on
  each. An empty domain offers a widget for it and, when the account has others, a way to see them.
  A row has the mode, the domains, the site key to copy, the secret on request, and **Add to your
  site**, edit, rotate and delete. A search shows from seven widgets.
- **The dialog.** Name and domain from the zone, three mode cards (Managed recommended), domain chips
  capped at 10 with localhost as a plain chip, and an Advanced section (pre-clearance for every plan;
  region, hide branding and ephemeral IDs marked Enterprise). After create: the site key, the secret,
  HTML, React, PHP and Node.js code reading `TURNSTILE_SECRET`, and Cloudflare's test keys folded away.
- **Rotation.** The old secret keeps working for two hours by default; "Stop the old secret now" is
  there for a leak. The new secret is shown at once.

## Tasks

- [x] T1 Shared types, the `turnstile` permission, widget rules, test keys and the snippet generators.
- [x] T2 The fake API: Turnstile routes, the permission grant, recorded widget payload, zone accounts.
- [x] T3 `CloudflareService`: zones keep Cloudflare's account id; list, create, update, delete,
  secret and rotate, with the Turnstile refusal and a gone widget in words.
- [x] T4 IPC with argument checks, and the preload.
- [x] T5 Domain chips with a smaller limit and localhost as a plain chip.
- [x] T6 The Turnstile tab: rows, scope toggle, empty states, search, delete, guided fix.
- [x] T7 The widget dialog and the ready panel; the rotate dialog; snippets; test keys.
- [x] T8 End to end against the Cloudflare fake on loopback (`e2e/cloudflareTurnstile.e2e.ts`).
- [x] T9 Help article (`cloudflare.md`) and these docs.

## Acceptance criteria

- AC1 With a token that has Turnstile, a widget for the open domain takes three clicks: the
  Turnstile tab, Add a widget, Create widget. Its site key, secret and code show right after.
- AC2 A secret is read from Cloudflare only on request (or comes with create and rotate), and is
  never written to disk.
- AC3 A token without Turnstile is told to add `Account > Turnstile > Edit`, and the main token
  report is unchanged.
- AC4 Only bare domains, a known mode, pre-clearance and region, and a real site key shape reach
  Cloudflare.
- AC5 Rotating keeps the old secret for two hours unless "Stop the old secret now" is picked.

## Known limits

- **Not tried against the real Cloudflare yet.** Built against the SDK's types and Cloudflare's API
  reference, and checked with the recorded fake (unit tests and e2e on loopback).
- The 10-domain cap is the Free and Pro limit. Enterprise accounts can hold more per widget, which the
  page does not offer yet.
- Bot Fight Mode on a widget (Enterprise) and Turnstile analytics are not offered.
