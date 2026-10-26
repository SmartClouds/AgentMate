# E14 Cloudflare

Milestone: M4 Security and operations. Depends on: E11, E13.

## Goal

Manage Cloudflare from the app: DNS, development mode, under attack mode, security rules and SSL
settings, and wire domains to servers without visiting the dashboard.

## Tasks

- [x] T1 Token setup in the desktop main process (official `cloudflare` SDK): guided creation of a
  minimally scoped token, permission check and display, `SecretEnvelope` storage.
- [x] T2 Zones and DNS records (A, AAAA, CNAME, TXT, MX, CAA, SRV) with proxied toggle and TTL.
- [x] T3 Zone settings: development mode, security level including "I'm Under Attack", SSL/TLS
  mode, Always Use HTTPS; cache purge (all or URLs).
- [x] T4 Security rules: WAF custom rules through the Rulesets API with a friendly builder (block a
  country, challenge a path, allow an IP) and IP access rules.
- [x] T5 Site integrations: "point domain to this server" (records from the server's public
  addresses), SSL method suggestion for proxied domains, Origin CA certificate install through the
  core.
- [x] T6 Cloudflare-only origin lock: firewall allows 80 and 443 only from Cloudflare's ranges
  (refreshed daily on the core), nginx restores the real client IP, optional Authenticated Origin
  Pulls.
- [x] T7 DNS-01: provision a separate zone-scoped `DNS:Edit` token to a server (Data Protection
  encrypted) for wildcard certificates.
- [x] T8 UI at `/deploy/cloudflare` plus entry points from the site editor.
- [x] T9 Fixture: recorded Cloudflare API responses for the SDK's fetch.

## Acceptance criteria

1. Missing token permissions produce a guided fix listing exactly what to add.
2. "Point domain to this server" creates or updates the right records idempotently.
3. With the origin lock on, the firewall rules match the fetched ranges for IPv4 and IPv6.

## Implementation notes

Desktop side, first part (df848e5): T1 to T4, T8, T9 and pointing a domain.

- The account token lives in the main process only, sealed with the Servers vault
  (`main/deploy/cloudflare/state.ts`). The SDK client (`client.ts`) is tree-shaken to the parts
  used and ignores every `CLOUDFLARE_*` variable of the environment, so nothing can redirect the
  token or add a second credential.
- The token guide opens Cloudflare's token page with the six zone permissions filled in. The check
  reads the token's own policies when it may, and otherwise tries a read-only call per permission
  (`tokenCheck.ts`). A later refusal names the permission (`errors.ts`) and the page shows exactly
  what to add (AC1).
- `pointDomain.ts` plans the address records from the records the zone has, so a second run finds
  nothing to change (AC2), and the batch is applied in one call.
- T9: `testing/fakeCloudflare.ts` serves recorded payloads (`recorded.ts`) to the real SDK through
  an injected `fetch`, with Cloudflare's own refusals for missing permissions.

Server side and the rest of the desktop (this commit): T5 to T7.

- Core module `Cloudflare/`: `CloudflareApi` (the ranges from `GET /ips`, no token; DNS records
  with the zone's own token as a bearer header and nowhere else), `CloudflareRangeList` (a list is
  taken whole or not at all: canonical public networks of the right family, not wider than /8 or
  /16, at most 100), `OriginLockPlanner`, `OriginLockService`, `DnsCredentials`,
  `CloudflareDns01Hook` and `OriginCertificates`. Hub methods in `CoreHub.Cloudflare.cs`; reads are
  Viewer, changes Admin, and each change is audited without request bodies.
- Migration `CloudflareOriginAndDns`: tables `DnsCredentials`, `OriginCertificateKeys` and
  `OriginLock` (one row).
- T5 Origin CA: the core makes a P-256 key and its signing request
  (`CreateOriginCertificateRequest`) and seals the key at once; the desktop sends the request to
  Cloudflare with the account token (`POST /certificates`, `origin-ecc`, 15 years) and hands the
  certificate back (`InstallOriginCertificate`), where it goes through E11's upload checks against
  the waiting key. Deviation from "through E11's UploadCertificate": a dedicated path, so the
  private key never leaves the server. New certificate source `cloudflareOrigin`; it never
  renews by itself. A request older than an hour is refused.
- T5 point domain: the addresses now come from the core's own `SystemInfo.PublicAddresses` when
  the server's core answers, and from the saved host otherwise. After the records are applied the
  dialog offers "Add a website", which opens the server's Websites section with a new site for the
  same names (`?newSite=`).
- T6 origin lock (Firewall section card): turning it on or off is a firewall change set through
  E13's `FirewallManager`, so the lockout guard, the 60-second countdown and the confirm over a new
  SSH connection all apply. It adds an allow rule per Cloudflare range on 80/tcp and 443/tcp
  (comment "cloudflare origin lock") and removes single-port rules that open them to everyone; a
  rule it cannot change is named instead. It refuses a firewall that is off or allows incoming
  traffic by default. The status compares the firewall with the ranges and lists what is missing,
  still open or stale for both families (AC3, checked through the hub and the planner).
- nginx (E10's renderer): with the lock on, each release gets `cloudflare/real-ip.conf`
  (`set_real_ip_from` per range, `real_ip_header CF-Connecting-IP`) included in every site's server
  blocks, never at the http level; with Authenticated Origin Pulls also Cloudflare's origin pull
  CA (embedded, fingerprint pinned in a test) and `ssl_verify_client on` on HTTPS. Golden variant
  `cloudflare-origin-lock`, which the system tests' nginx harness checks with a real `nginx -t`
  (needs Docker; not run on this machine).
- Daily refresh: `OriginLockService` fetches the ranges five minutes after start and then every
  day. When they changed and the lock is on, the core brings the firewall up to date by itself
  with `FirewallManager.ApplyUnattendedAsync`: only allow rules for single ports 80 and 443 may be
  added or removed, and only while sshd listens on neither, so it cannot touch SSH; the rules are
  saved first and put back at once if a step fails, and the change set is recorded as confirmed by
  the core and audited. Note: planning a refresh also removes any rule a person added later that
  opens 80 or 443 to everyone; that is the lock doing its job, but it happens unattended. A failure
  raises the new alert `originLockRefreshFailed`.
- Authenticated Origin Pulls: the desktop turns `tls_client_auth` on for every zone that holds one
  of the server's site domains before the core makes nginx ask for the certificate, and refuses
  when a site domain is in no zone of the account. The review dialog also flags site domains that
  are not proxied, since the lock makes them unreachable. Turning the lock off leaves
  `tls_client_auth` on at Cloudflare, which is harmless.
- T7 DNS-01: from the zone's new Servers tab the desktop makes a token with only `DNS Write` on
  that one zone (`POST /user/tokens`, the group id taken from `permission_groups`), or checks a
  pasted one (verify, read the zone's records, and refuse the account token itself), and sends it
  to the server (`SaveDnsCredential`). The core checks it with Cloudflare, seals it with Data
  Protection under its own purpose and never returns it. A token the app made is deleted at
  Cloudflare when the server refuses it or it is removed.
- The DNS-01 hook E11 left open: `CloudflareDns01Hook` adds the TXT record with the zone's token
  (the longest stored zone the name ends in), waits 20 seconds for Cloudflare's edge, and removes
  it after validation (by id, or by name and value after a restart). `ICertificateAuthorities`
  now asks whether DNS-01 covers every domain (`CanAnswerDns01Async`), so a wildcard or a
  "validate over DNS" order without a token is refused at once with what to do. A wildcard order
  uses DNS-01 for all its names.
- The SSL tab offers "Cloudflare Origin CA" and a "Validate over DNS" switch, enabled when the
  server holds a token for the zone of every domain.
- Guided fixes for the new features (AC1): Origin CA needs `Zone > SSL and Certificates > Edit`
  and making a DNS token `User > API Tokens > Edit`. They are optional permissions, named only
  when Cloudflare refuses a call, so the main token can stay without them; for the second one the
  fix also offers pasting a token made by hand.
- e2e: `cloudflareServer.e2e.ts` runs the recorded fake on loopback (`e2e/fakeCloudflareServer.ts`)
  and points the app at it with `RUNOVA_E2E_CLOUDFLARE_API`, honoured only in an e2e run of an
  unpackaged build. It saves the token, sends the DevHost a DNS token and locks the DevHost to
  Cloudflare with the firewall countdown.

What is left or unverified:

- The DNS-01 hook waits a fixed 20 seconds rather than asking Cloudflare's authoritative name
  servers; no test reaches Cloudflare's live DNS.
- Origin CA is tested with a certificate signed in the test (core) and the recorded fake
  (desktop), not in the e2e run: the fake cannot sign the core's real request.
- Renewal does not remember that a certificate was issued over DNS-01: a plain name is renewed
  over HTTP-01 first, which still works through the proxy.
- No visual pass in both themes yet; states are asserted through the DOM.
