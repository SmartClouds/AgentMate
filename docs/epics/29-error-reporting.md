# E29 Error reporting

Milestone: standalone (Deploy). Depends on: E01 (the server core), E04 (identity, roles and step-up),
E09 (the logs center and the redactor's use there), E15 (the Security center it lives in).

## Goal

A person gives a Deploy server a Sentry DSN, and from then on the server's core sends its own warnings
and errors to that Sentry project, so a problem on the server reaches them without anyone watching the
Logs section. The core does it with OpenTelemetry (OTLP over HTTP), straight to Sentry's OpenTelemetry
intake. The setup lives in the Security area as an Error reporting tab, with a status card, a settings
form and a test event button.

This is the write side of Sentry. E24 (Error tracking) is the read side, where the app lists issues
from the user's own projects with an API token; the two share nothing but the product's name.

## Design

- **The core owns it.** It has to keep reporting with the app closed. The DSN, environment, server
  name, level and on/off are kept by the core in `error-reporting.json` in its state folder (root only,
  written atomically). The DSN is sealed with Data Protection (`AgentMate.ErrorReporting.Dsn.v1`), so
  a copy of the file alone holds no key. The app keeps nothing.
- **No Sentry SDK.** Sentry takes OTLP logs directly at
  `/api/<project id>/integration/otlp/v1/logs`, signed with `x-sentry-auth: sentry sentry_key=<key>`.
  Both come from the DSN. The core uses `OpenTelemetry` and `OpenTelemetry.Exporter.OpenTelemetryProtocol`.
- **A logger provider next to the console.** `ErrorReportingLogs` is an `ILoggerProvider`. Its loggers
  forward to whichever pipeline is live, so turning reporting on, off or to another project, and
  changing the level or environment, take effect at once. A pipeline is a real OpenTelemetry logger
  provider with a batch processor and the OTLP exporter, built for one setup and replaced for the next.
  The old one sends what it still holds before it closes.
- **Scrubbed before it leaves.** The forwarding logger runs the message, every attribute and the exception
  through the existing `Redactor` first. A value logged under a secret-like name (`{Password}`) is also
  masked wherever it shows up in that call, including the rendered message. The exception goes out as
  `exception.type`, `exception.message` and `exception.stacktrace` attributes, redacted.
- **No feedback loop.** The exporter's own logs and the HTTP client's (`OpenTelemetry*`,
  `System.Net.Http*`) and the reporting classes' own are never forwarded, so a Sentry that is down cannot
  report its own failure to itself.
- **Delivery facts for the screen.** A handler in front of the network signs each request and records how
  Sentry answered (or that it could not be reached), in words: key rejected, no such project, too many
  events, a redirect (never followed), a network error. The records in each request are counted from the
  OTLP bytes, so "sent N events" is true.
- **Crashes are reported.** The core had no global exception hook. `AppDomain.UnhandledException` is logged
  Critical (or Error if the process survives) and flushed before the process goes; an unobserved task
  exception is logged Error.
- **Rules.** HTTPS only, except a Sentry on this machine (`localhost`, `127.0.0.0/8`, `::1`) over plain
  HTTP. No redirects. The old secret part of a DSN is dropped. A level is Warning (warnings, errors and
  crashes) or Error (errors and crashes).
- **Roles.** Admin reads the status and sends a test event. Owner, with a step-up, sets it up, changes
  it or removes it, since it sends the core's logs to a third party. Every action is audited with the
  host and project, never the key. The key is never returned by any call; leaving it out of a save keeps
  the stored one.
- **The app.** `deployErrorReporting` IPC (status, save, remove, test), a `DeployErrorReporting` service,
  and a card in the Security panel. A core older than this feature answers "Method does not exist", which
  the app turns into a plain sentence and an Update the core button.

## Tasks

- [x] T1 DSN: parse and check on both sides with the same case table (`SentryDsn.cs`,
  `errorReportingValidation.ts`).
- [x] T2 Settings file with the sealed DSN; options checked (`ErrorReportingStore`, `ErrorReportingConfig`).
- [x] T3 The pipeline: forwarding logger, redaction, OpenTelemetry exporter, delivery record, live swap
  (`ErrorReportingLogs`, `DeliveryTracker`, `SentryDeliveryHandler`, `OtlpRecordCounter`).
- [x] T4 Manager, crash hooks and start-up; hub methods and contracts; audit.
- [x] T5 Desktop main: service, IPC, preload, fake core.
- [x] T6 Renderer: the Error reporting tab (status card, settings form, test event, remove).
- [x] T7 Help article and these docs.
- [x] T8 End to end against the real core and a fake Sentry on loopback
  (`deployErrorReporting.e2e.ts`, with `fakeSentryIngest.ts`): set up, test event, a refusing Sentry,
  pause, remove, and the key on neither the screen nor this computer's disk.

## Acceptance criteria

- AC1 With a DSN saved, a warning logged by the core reaches the project as an OTLP log record, signed
  with the key, with the environment and server name that were chosen. Information lines do not.
- AC2 Saving, pausing, removing and changing the level take effect with no restart.
- AC3 A password, token or key in a message, a structured value or an exception never reaches the
  request body.
- AC4 The key never comes back from the core, never shows on screen, never reaches the app's disk and
  never appears in the audit trail.
- AC5 A test event says whether Sentry took it and, if not, why in words. A Sentry that is down or says
  no never reaches the code that logged.
- AC6 Only an Owner with a step-up can change it; an Admin can read it and test it; a Viewer sees nothing.
- AC7 A crash that stops the core is sent before it stops.

## Known limits

- **Not tried against a real Sentry.** Everything was built and checked against the OpenTelemetry SDK, the
  core's real host and a fake Sentry on loopback. Whether sentry.io and a self-hosted Sentry accept this
  wire format (protobuf over HTTP), and show the records under Logs, has not been observed. Sentry's
  pages for the intake do not name the format; their OpenTelemetry Collector guide uses the standard
  `otlphttp` exporter, which sends protobuf, the same as this one. Sentry labels the intake open beta.
- The delivery record and counts live in memory: a restart of the core starts them again.
- Queued records are lost if the core is killed (not stopped), as with any batching exporter.
- Traces and metrics are not sent, and a log does not become a Sentry Issue.
- Reporting is per server; there is no shared setup across servers.
