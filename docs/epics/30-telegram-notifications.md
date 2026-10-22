# E30 Telegram notifications

Milestone: standalone (Deploy). Depends on: E01 (the server core), E04 (identity, roles and step-up),
E06 (Docker events), E09 (alerts and the redactor), E28 (server backups).

## Goal

Each Deploy server gets a Notifications section where an Owner connects a Telegram bot, names the
person or group to message, and sets the server name that starts every message. From then on the
server's core sends its important events and errors to that chat: a failed backup, a container that
keeps restarting, a disk filling up, a failed job, a certificate that did not renew. It does this
whether or not the app is open.

## Design

- **The core owns it.** It has to keep sending with the app closed. The bot token, chat, server name,
  alert kinds, the resolved-note switch and on/off are kept by the core in
  `telegram-notifications.json` in its state folder (root only, written atomically). The token is
  sealed with Data Protection (`AgentMate.Notifications.Telegram.Token.v1`) and never returned.
- **Alerts are the source.** `TelegramNotifier` (a hosted service) subscribes to `AlertCenter` and
  runs each change through `TelegramPolicy`: a message when an alert opens, when it gets worse
  (a higher severity), and, if asked, when it resolves after a message about it went out. Repeats,
  acknowledgments and kinds that were turned off send nothing. It starts from the alerts open when
  the core starts (counted as already told, so a restart sends nothing again), and when the alert
  center lets it go for falling behind it resubscribes and catches up from the last revision it
  handled. A failed send is counted and shown, and the next raise of that alert tries again.
- **Two new alert kinds.**
  - `BackupFailed`: `BackupRunner` raises it per plan (`backup-plan:<id>`, or `backup:manual`) when
    a run is refused, the archive cannot be made (critical), or not every destination took it
    (warning, naming each destination and its error). The plan's next good run resolves it.
  - `ContainerCrashLoop`: `ContainerWatcher` follows Docker's events in the background and feeds
    `CrashLoopDetector`. Three exits with a non-zero code inside ten minutes make a loop (critical).
    An exit within a minute of a `stop` or `kill` was asked for and does not count. Ten quiet minutes,
    or removing the container, resolve it. Without Docker the watcher waits and retries, up to a
    minute apart. Loops left open from before a restart clear the same way.
- **Bot API, plain text.** `TelegramBotClient` posts `sendMessage` to `api.telegram.org` (no redirects),
  in plain text so nothing in an alert needs escaping, with link previews off. Answers become words a
  person can act on (token not accepted, chat not found, bot blocked or not a member, too many
  messages). A `retry_after` of up to 30 seconds is waited out once. The token is part of the address,
  so everything said about a failure is scrubbed of it, whole and its secret half.
- **The message.** `🔴 Critical on <server name>: <title>` and the alert's own (redacted) message on the
  next line; `✅ Resolved on <server name>: <title>` when it clears. Clipped to Telegram's 4096
  characters. The titles match the app's own notifications (`watcher.ts`).
- **Roles.** Admin reads the status and sends a test message. Owner, with a step-up, sets it up,
  changes it or removes it, since it sends what happens on the server to a third party. Every action
  is audited (`telegram.save`, `telegram.remove`, `telegram.test`) with the chat and kinds, never the
  token. Leaving the token out of a save keeps the stored one.
- **The app.** `deployTelegram` IPC (status, save, remove, test, detectChat), a `DeployTelegram`
  service, and a Notifications section with a status card and a settings form. **Detect** asks
  Telegram's `getUpdates` from this computer for the chat that last wrote to the bot, the one time the
  token goes anywhere but the core. The form prefills the server name with the Deploy nickname. A core
  older than this feature answers "Method does not exist", which the app turns into a plain sentence
  and an Update the core button. Problems now names failed backups and crash loops the core saw, and
  lists a loop once when the container's own state already shows it.

## Tasks

- [x] T1 Settings: token, chat and name checks on both sides with the same case table
  (`TelegramConfig.cs`, `telegramValidation.ts`); the sealed store (`TelegramStore`).
- [x] T2 Bot API client with the fake Telegram (`TelegramBotClient`, `FakeTelegram` answers).
- [x] T3 Message text and the send policy (`TelegramMessages`, `TelegramPolicy`).
- [x] T4 Manager, notifier, hub methods and contracts; audit.
- [x] T5 `BackupFailed` from `BackupRunner`.
- [x] T6 `ContainerCrashLoop`: detector and watcher.
- [x] T7 Desktop main: service, IPC, preload, fake core; alert titles and Problems.
- [x] T8 Renderer: the Notifications section (status card, settings form, Detect, test, remove).
- [x] T9 Help article and these docs.
- [x] T10 End to end against the real core (the DevHost) and a fake Bot API on loopback
  (`deployTelegram.e2e.ts`, with `fakeTelegramApi.ts`): set up, a test message, a crash loop made on
  the DevHost (`/dev/containers/crash`) that the core's own watcher and notifier deliver, the token on
  neither the screen nor this computer's disk, a refusing Telegram, and remove. The DevHost is pointed
  at the fake with `Core:Telegram:ApiBase`, which only a Development core honors, and only for this
  machine.
- [ ] T11 Send from a real server to a real bot and chat.

## Acceptance criteria

- AC1 With Telegram set up, an alert of a chosen kind that opens reaches the chat once, starting with
  the server name; raising it again sends nothing; getting worse sends one more; clearing sends a
  resolved note when that is on.
- AC2 A backup that fails, or that a destination does not take, raises a `BackupFailed` alert, and the
  plan's next good run resolves it.
- AC3 A container that exits on its own three times in ten minutes raises a `ContainerCrashLoop` alert;
  stopping or killing it by hand does not.
- AC4 Saving, pausing, removing and changing the kinds take effect with no restart, and a restart sends
  nothing for alerts that were already open.
- AC5 The token never comes back from the core, never shows on screen, never appears in an error, a
  log line or the audit trail.
- AC6 Only an Owner with a step-up can change it; an Admin can read it and test it; other roles see no
  setup.

## Known limits

- **Not tried against a real bot yet.** Everything was built and checked against a fake Telegram that
  answers the way the Bot API documents. Sending from a real server to a real chat is task T11.
  **Detect** calls the real `getUpdates` from the desktop and is covered by unit tests only.
- Delivery counts live in memory: a restart of the core starts them again.
- An alert raised while Telegram is down is not queued: the next raise of that alert tries again, and a
  one-off alert (a firewall rollback) can be missed. The app's own inbox still has it.
- Crash loops are per container name and in-memory: a restart of the core forgets crashes counted so far.
- Health checks (E22) run in the desktop app, so a website that goes down is not sent from the server.
- One chat per server. Several chats, or other channels (email, Slack), are not part of this epic.
