---
title: Notifications and Telegram
category: Settings
order: 50
summary: How Runova tells you when an agent finishes or needs you, through system notifications, the Recent messages bell, the desktop pet and a Telegram bot, plus usage alerts.
keywords: notifications, notify, alert, telegram, bot, botfather, chat id, toast, system notification, windows toast, bell, recent messages, hook, completion, confirmation, usage alert, threshold, reset alert, pet, away
route: /settings?tab=notifications
---

Runova can reach you when you are looking at something else. A system notification pops up when an agent finishes or asks a question, the bell in the header keeps a history of messages, your desktop pet can speak up, and a Telegram bot can send messages to your phone. This article explains each channel, how to turn it on, and what it says.

## Where to find it

- System notification switches: **Settings**, **General** (**Workspace notifications** and **Terminal AI notifications**).
- Telegram bot: **Settings**, **Notifications**, **Telegram bot** (`/settings?tab=notifications`).
- Per-project hooks: open a project, then its **Hooks** section.
- Usage alerts: the **Token Usage** page.
- Past messages: the bell button (**Recent messages**) in the header.

## The channels at a glance

| Channel | Good for | Set up in |
| --- | --- | --- |
| System notification | An agent finished or needs you while Runova is in the background | Settings, General |
| Recent messages (bell) | A list of past alerts, errors and updates | Always on |
| Telegram | Messages on your phone while you are away | Settings, Notifications, plus a project's Hooks |
| Desktop pet | A short speech bubble on your desktop | Settings, AI Pet, plus a project's Hooks |

## System notifications

### Workspace notifications

**Workspace notifications** is on by default. When an agent in a Workspace tab finishes or asks you something, and you are not looking at that tab (another tab, another page, another app, or the window is minimized), Runova shows a system notification.

- The title is "{agent} finished" or "{agent} needs your input". A question wins over a finished run if both happen at once.
- The body names the project and the tab, adds the agent's own message when it sent one, and says "and N more tabs" when several tabs wanted you at about the same time.
- When an agent needs your input, the taskbar icon also flashes.
- Clicking the notification brings Runova forward and opens that Workspace tab.
- If you are already looking at the tab, nothing is shown.

The same switch also gates the notification you get when a version update finished in the background ("{project}: version files updated" or "version update failed"). Clicking it reopens the review.

Turn it off in **Settings**, **General**, **Workspace notifications**.

### Terminal AI notifications

**Terminal AI notifications** is on by default. It covers AI tasks you started in a terminal (the Ask AI helper in an SSH terminal) and in a Remote Desktop session. When one of them needs you while that terminal is hidden or you are in another app, you get a system notification:

| Title | Meaning |
| --- | --- |
| AI wants to run a command | The task proposed a command and waits for your approval (SSH terminals). |
| AI has a question for you | The task needs an answer. |
| A command is asking for a password | A command in the terminal is waiting for a password. |
| AI wants to act on the remote desktop | The task proposed an action on a Remote Desktop session and waits for approval. |
| AI task paused | The task stopped but can be continued. |

Clicking it opens that terminal session, or brings the Remote Desktop session window forward. Turn it off in **Settings**, **General**, **Terminal AI notifications**.

### Other system notifications

A few more things use the same system notifications:

- **Server alerts** from Deploy: a warning or critical alert on one of your servers (disk filling, a failed job, a certificate that did not renew and so on) shows a notification when Runova is not in the foreground, and clicking it opens that server.
- **Relay alerts** from [Relay tasks](relay.md): a task is blocked, is done but its tests fail, a session ended or stopped without its handoff, a session is not moving, a plan is ready for you to look at, or the relay finished. A system notification appears and clicking it opens that project's Workspace. The same message is kept in Recent messages with a **Relay** tag, as a success when the relay finishes cleanly and as a warning for everything else.
- **Usage threshold alerts** from Token Usage (see [Usage alerts](#usage-alerts)).

If your system does not support notifications, Runova falls back to messages inside the app where it can.

## Recent messages

The bell button in the header, labeled **Recent messages**, opens a panel with the alerts that flashed in the corner, grouped by day, in case you missed one. It shows a small dot when something is unread (red for an error). You can search it, filter by **All**, **Errors**, **Warnings**, **Success** and **Info**, click an entry to open what it is about, remove entries one by one, or **Clear history**.

Pipeline results, CLI and tool updates and server alerts land here too. A daily check for CLI and tool updates adds an entry when a newer version exists (turn it off in **Settings**, **General**, **Check for CLI and tool updates**). You can also open Recent messages from the command palette.

## Telegram

### Set up the Telegram bot

You need a bot of your own. It takes a couple of minutes.

1. In Telegram, message @BotFather and create a bot. Copy the token it gives you.
2. In Runova, open **Settings**, **Notifications**, **Telegram bot** and paste the token into **Bot token**.
3. In Telegram, send your new bot any message.
4. Back in Runova, click **Detect from last message**. The **Chat ID** fills in from the latest message the bot received. (If it says "No messages found yet", send the bot a message and try again.)
5. Click **Send test**. A message "This is a test notification from Runova." (with a waving hand in front) should arrive in Telegram.
6. Click **Save changes** (or press `Ctrl+S`). A badge on the card shows **Ready** as soon as both a token and a chat ID are filled in.

**Scheduled tasks chat/group ID** is optional. Fill it in to make [scheduled prompts](scheduled-tasks.md) post to a different chat or group, such as a team group. Group ids start with a minus sign, for example -1001234567890.

The token and chat ID are used by project hooks, scheduled task messages and Token Usage reset alerts. If Telegram is not set up, those features quietly do nothing. All Telegram traffic goes through the [proxy](settings.md#proxy) you set in Settings, if any.

### What Telegram sends

| What | When | Text |
| --- | --- | --- |
| Completion hook | A project's agent finishes | Your message for that project. Default: "✅ {{project}} has finished its work." |
| Confirmation hook | The agent needs your confirmation | Your message for that project. Default: "⏸️ {{project}} needs your confirmation to continue. Reply to this message to continue." |
| Scheduled task | A scheduled prompt is created | A card with the project, target AI, CLI, run time and status. The same message is edited as the status changes. See [Scheduled tasks](scheduled-tasks.md). |
| Reset alert | A subscription limit window rolls over | "Claude Code: Session (5h) limit reset" with the plan, the reset time and the next reset. |

### Project hooks

Each project has its own notification hooks, so you choose which projects can message you. Open a project, then its **Hooks** section. There are three cards, each with an on/off switch:

- **Completion** sends a Telegram message when the agent finishes its work.
- **Confirmation** sends a Telegram message when the agent needs your confirmation to continue.
- **Desktop companion** speaks the message through the desktop pet when the agent finishes.

To set one up:

1. Turn the card's switch on.
2. Under **Installed agent** pick the agent the hook belongs to. Only CLIs detected on your machine are listed.
3. Edit the **Telegram message** (or **Companion message**). Write `{{project}}` where the project name should appear.
4. Click **Save**, then **Send test** (or **Preview on pet**) to check it.

For Claude Code, Runova wires the hook automatically: it writes a small script to `.runova/hooks/` in the project folder and adds it to the project's `.claude/settings.json` (the Completion and Desktop companion hooks use Claude Code's Stop event, Confirmation uses its Notification event). For any other agent the card shows the script path (click it to copy), and you wire that script into the agent's own hook or automation settings. The script only pings Runova on your own machine, and it quietly does nothing when Runova is closed, so your agent never sees an error.

If Telegram is not configured the Hooks section says so and offers **Open Settings**. If the pet is off, the Desktop companion hook stays quiet until you turn it on.

The **Hooks** section also lists **Other hooks** it finds in the project's `.claude/settings.json` and `settings.local.json`, which you can edit or delete there.

### Reply from Telegram

After a Confirmation message is sent, Runova listens for your reply for up to 20 minutes. The next message you send from your chat is typed into that project's open terminal and submitted with `Enter`, so you can answer the agent from your phone. With several projects waiting, the oldest question gets the reply. Only messages from your saved chat ID are used.

## Usage alerts

Two alerts watch your AI subscription limits. They live on the **Token Usage** page, on the card of the watched provider (Claude Code by default), as two buttons in the card's header.

- **Threshold alert** (the warning triangle). Sends a system notification the moment a watched window reaches a percentage you pick. Open the dialog, turn on **Notify at threshold**, set **Threshold (%)** between 1 and 100 (the default is 90) and choose which windows to watch: **Session (5h)**, **Weekly** or the model-specific weekly window, where your plan has one. It fires once per window and can fire again after the window rolls over. **Send a test alert** shows what it looks like. Clicking the notification opens Token Usage on that provider. Runova checks about once a minute.
- **Reset alert** (the bell). Sends a Telegram message when a watched window rolls over, so you know you have your full quota again. Open the dialog, turn on **Telegram reset alert** and pick the windows. **Chat/group ID** lets this alert use a different chat from the one in Settings (leave it empty to reuse it). The bot token always comes from Settings. **Send a test alert** checks the setup.

Both are off until you turn them on. See [Token usage](token-usage.md).

## Desktop pet messages

When the desktop pet is on, it can show a speech bubble for several things: a project's Desktop companion hook, a GitHub Actions run that failed or passed, an internet quality change, and a CLI that needs input or finished. Each of those has a switch in **Settings**, **AI Pet**, **Alerts**. A bubble for a failed run is a link: click it to open that run in Pipelines. See [Widgets and the desktop pet](widgets-desktop-pet.md).

## Tips

- If you never see system notifications, check that your operating system allows notifications for Runova and that Focus or Do Not Disturb is off.
- A notification is only sent when you are not looking at the tab. Switch to another tab to test one.
- Use **Send test** after saving the token, before you rely on a hook.

## Related

- [Settings](settings.md)
- [Scheduled tasks](scheduled-tasks.md)
- [Widgets and the desktop pet](widgets-desktop-pet.md)
- [Token usage](token-usage.md)
- [Workspace terminals and agents](workspace-terminals-agents.md)
- [Troubleshooting](troubleshooting.md)
