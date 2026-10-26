# E16 Direct TLS mode

Milestone: M4 Security and operations. Depends on: E15.

## Goal

Reach the core without SSH when a server does not allow it, without weakening security: mutual TLS
with the enrolled device keys and a certificate pinned at install time.

## Tasks

- [x] T1 Optional HTTPS listener with a self-signed ECDSA certificate generated at install; its
  public key pin is read over SSH and stored with the server.
- [x] T2 mTLS: client certificates derived from the E04 device keys; unknown certificates are
  rejected during the handshake.
- [x] T3 Firewall rule for the port with an optional source restriction.
- [x] T4 Desktop connection option and fallback order (direct, then tunnel, or the reverse).

## Acceptance criteria

1. Connections without a client certificate or with an unknown one fail during the handshake.
2. A certificate that does not match the pin is refused.
3. Turning the mode off removes the listener and the firewall rule.

## Implementation notes

- **Where it lives.** Server core: `DirectTls/` (settings, certificate, the Kestrel endpoint, the
  device lookup and per-request guard, the manager and its start-up), `Hubs/CoreHub.DirectTls.cs`
  and `Contracts/DirectTlsContracts.cs`, plus the device binding in `Security/DeviceTokenHandler.cs`
  and `Endpoints/AuthEndpoints.cs`. Desktop main process: `main/deploy/directTls/` (client
  certificate, TLS transport and pin check, the service the IPC uses), the fallback in
  `main/deploy/service.ts`, the pin store in `state.ts`, and `main/ipc/deployDirectTls.ts`.
  Renderer: `components/deploy/security/directTls/`, on a new Connection tab of the Security area,
  and the connection pill (`overview/ConnectionBadge.tsx`). Shared: `shared/deployDirectTlsTypes.ts`
  and `shared/deploy/directTlsValidation.ts` (form checks and the firewall change sets).
- **T1, the listener.** Off by default: no TCP port exists until an Owner turns it on. The listener
  is a Kestrel configuration endpoint fed by a configuration provider of the core's own, so turning
  it on, moving it or turning it off rebinds at runtime (Kestrel reloads its endpoints) and leaves
  the Unix socket alone; no restart. A spike proved the reload first. The setting lives in
  `/var/lib/runova-core/direct-tls.json` (0600), not in `core.json`, which the installer owns.
  Everything that matters is set in code, not configuration: TLS 1.3 only, HTTP/1.1, a 10 second
  handshake limit, client certificate required. A taken port is refused up front with a plain
  message; a bind that still fails shows as "On, but the port is not open" with the reason.
- **T1, the certificate and pin.** ECDSA P-256 from the BCL (`CertificateRequest`), made on the
  core's first start, which is the install, and kept in `/var/lib/runova-core/tls/` (key 0600).
  Making it on start rather than in an install step also covers cores installed before E16. The
  pin is base64 SHA-256 of the SubjectPublicKeyInfo. The app only ever takes it from a call made
  over SSH (`DeployService.withSshHub`, which skips the lasting link when that rides direct TLS),
  on the first read of the Connection tab, when an Owner turns the mode on, or when the Owner
  accepts a changed key. A key that changed is reported, never taken quietly.
- **T2, why the desktop signs its own certificate.** Of the two options, the desktop makes an X.509
  certificate for its device key on every connection, self-signed with that key, and the core
  checks only that the certificate's public key is a P-256 key of an enrolled device that is not
  revoked. The TLS handshake (CertificateVerify) already proves the caller holds the private key,
  so the certificate's own signature, names and dates carry nothing, and a core-issued certificate
  would add a CA key to guard, an issuing protocol and renewals without adding a check. Node has
  no X.509 writer and the packages that have one are either RSA only or from authors the project
  avoids, so the few DER structures are written by hand (`directTls/clientCertificate.ts`, tested
  by parsing them back with Node's `X509Certificate`).
- **T2, revocation and binding.** The device is looked up in the database on every handshake and
  again on every request over the TLS listener (`DirectTlsGuard`), so a revocation counts at once:
  new handshakes fail, a kept-alive connection gets its next request refused, and the hub
  connections are closed by the revocation as before. Over TLS a token must belong to the device
  whose key made the handshake, and challenge, login and renew must name that device; enrolling a
  new device over TLS is refused (that goes over SSH). Sign-in, sessions, roles and step-up apply on
  top, and the Host and Origin guards are unchanged.
- **T3, firewall.** The rule is an E13 change set the renderer applies through the Firewall calls,
  so it gets the review with the exact commands, the SSH lockout guard and the countdown kept over
  a new SSH connection. The card offers it after turning the mode on, moving it (old rule out, new
  in) or turning it off. Rules carry the comment "Runova direct TLS" on ufw; firewalld keeps no
  comments, so there a rule is matched by port, protocol and the sources the mode used. Deviation:
  the source restriction is also enforced by the core itself, before the handshake (a connection
  middleware on the endpoint), so it holds with the firewall off or bypassed. Sources are checked
  in the form, in the IPC handler and again on the core (addresses or CIDRs, no host bits, no /0,
  at most 16).
- **T4, fallback order.** Direct TLS first when this computer has it on and the port answered
  lately, then the SSH tunnel and the bridge exactly as before. A port that does not answer, or a
  handshake the core turns down (a revoked device lands in "needs re-enroll" through the SSH
  renewal), is left alone for a minute. A pin mismatch is a hard stop: the link waits with
  "Certificate mismatch" on the pill and a message that says why, and nothing is tried over SSH
  that could hide it. The pill also says what a live connection rides on (SSH, direct TLS or
  loopback). Short calls probe the port's health first (cached 30 seconds), so a call that changes
  something is never sent twice. The "or the reverse" order of the task was left out: SSH first
  would never reach the TLS port while SSH works, which is the same as the mode being off on this
  computer.
- **UI.** The Connection tab shows the state in words and a mark, the address, who may connect,
  the pin (copyable), when it was pinned and that it came over SSH, the certificate's end date and
  what this computer does. Owners get the form (port, sources, with the step-up asked for when the
  last one ran out), change and turn off (confirmed); everyone else reads.
- **Evidence.** Server core: `DirectTlsListenerTests` (11, a real Kestrel on loopback: off by
  default, health with a device certificate and the pin, no certificate, an unknown key, a wrong
  pin, a revoked device on a new and on an open connection, token and challenge binding, Host and
  Origin guards, sources before the handshake, off closes the port, survives a restart),
  `HubDirectTlsTests` (10: roles, step-up, validation, audit) and `DirectTlsSettingsTests` (10).
  Desktop: client certificate, transport against a loopback TLS server (pin match, mismatch before
  any byte, unreachable), the fallback order in `service.directTls.test.ts`, the service, IPC,
  state, validation, the pill and the card in every state. `e2e/directTls.e2e.ts` turns it on
  against the DevHost (which serves the TLS listener on loopback only), keeps the firewall rule,
  sees the pill move to direct TLS, and turns it off again. `directTls.int.test.ts` (with
  `RUNOVA_SYSTEM_TESTS=1`) does it on the ufw test server: the port closed by ufw until the
  change set opens it (the link falls back to SSH meanwhile), the link on TLS, AC1 and AC2 with raw
  handshakes, a second device refused once revoked, and AC3 with `ss` and `ufw status`.
