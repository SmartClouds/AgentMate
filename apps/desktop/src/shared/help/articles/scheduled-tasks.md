---
title: Scheduled tasks
category: Settings
order: 60
summary: Schedule a prompt to run in an agent CLI later, either when you press Run or automatically at a set time, and follow it from the project's Prompts section and Telegram.
keywords: scheduled, schedule, scheduled prompt, timer, run later, automatic, auto run, cron, queue, missed, run now, prompts, drafts, telegram, calendar, delayed, agent
---

A scheduled task is a prompt you have lined up to run on a project later. It can wait for you to press **Run**, or it can open your agent CLI by itself at a time you pick, with the CLI, model and effort you chose. Scheduled tasks live in each project's **Prompts** section, next to its history and drafts.

## Where to find it

Open a project (click it on the **Projects** page), then open its **Prompts** section. The section has three views: **History**, **Drafts** and **Scheduled**. The **Scheduled** view is the list of scheduled tasks, and its badge counts the ones waiting (it turns red when one is missed). The address is the project page with `?tab=prompts&view=scheduled`. Older links to a separate "Schedule" section land here too.

You can create a scheduled task from three places:

- The **Prompts** section of a project: **New prompt** (or **Schedule a prompt** on an empty Scheduled view).
- The **Prompt Builder** page, with **Status** set to **Scheduled**.
- The **Build Prompt** dialog for a project (open it from the Workspace or the Projects page), through the arrow next to **Open in agent** and then **Add scheduled task**.

## Schedule a prompt from the Prompts section

1. Open the project's **Prompts** section and click **New prompt**.
2. At **Save as**, choose **Scheduled** ("Ready to run"). The other choice, **Draft**, is for a prompt you are still writing.
3. Type or paste the **Prompt**.
4. At **Run**, choose **Manually** ("When you press Run") or **Automatically** ("At a set time").
5. For **Automatically**, set **Run at** to a date and time. It shows "Runs in 12m" style text, and refuses a time that has already passed.
6. Optionally pick the **CLI**, **Model** and **Effort**. Left empty, the CLI is chosen when the task runs (see below).
7. Click **Schedule**, or press `Ctrl+Enter` in the prompt box.

The task appears in the **Scheduled** view. If Telegram is set up, a message about it is posted (see [Telegram messages](#telegram-messages)).

### Schedule a draft

A draft is a prompt you parked to finish later. In the **Drafts** view, click **Schedule it** on the draft. A dialog titled **Schedule this draft** asks for the run mode, time and CLI, and the draft moves to **Scheduled**.

### Schedule a series from Prompt Builder

On the **Prompt Builder** page, pick the **Project** and set **Status** to **Scheduled**. A **Scheduled series** box appears:

1. Choose how the series runs: **Automatically at each time** or **Manually, when I press Run**.
2. Optionally set the **CLI**, **Model** and **Effort** for the whole series.
3. Click **Add task** for each step. Give every task its text and, for automatic runs, its own date and time.
4. Click **Save N task(s) to schedule**.

Each task is turned into a prompt for the project and saved to its **Scheduled** view. A project must be chosen, otherwise the box asks you to choose one.

### Schedule from the Build Prompt dialog

After you generate a prompt in the **Build Prompt** dialog, open the menu next to **Open in agent** and click **Add scheduled task** ("Run it later, by hand or at a set time"). The same scheduling dialog opens with the generated prompt filled in, and with the CLI, model and effort the dialog suggested.

## How automatic tasks run

Runova checks for due tasks every 30 seconds while it is open. When an automatic task's time arrives it opens a new terminal tab in the project's folder, starts the CLI with the prompt and presses `Enter`. A message says "Scheduled prompt started in" the CLI name, and the task moves to **Ran**.

The CLI is picked in this order: the task's own CLI, then your **Default CLI** from Settings, then the CLI that belongs to the task's target AI. If none of them can run it you see "A scheduled prompt was due, but no CLI is set up to run it." Model and effort are only used with the CLI they were picked for.

> [!WARNING]
> Runova has to be running at the scheduled time. A task more than 2 minutes late (the app was closed, or the computer was asleep) is not started, because opening a CLI hours late would be a surprise. It is marked **Missed** instead.

## Manage scheduled tasks

The **Scheduled** view groups tasks under **Needs attention** (missed), **Up next** (waiting, with automatic ones sorted by time) and **Done** (ran or cancelled). A row shows its status, **Manual** or **Auto** with the time and countdown, and the CLI, model and effort chips ("Default CLI" when none was chosen). Use the search box above the list to filter.

Row actions:

- **Run now** starts it right away in a new terminal tab and marks it **Ran**. After a task has run or been cancelled the button reads **Run again**.
- **Edit** changes the prompt, run mode, time and CLI. Giving a **Missed** task a new time puts it back in the queue.
- **Copy prompt** copies the prompt text.
- **Cancel** stops a waiting task from running and marks it **Cancelled**.
- **Delete** removes it after you confirm.

A **Missed** task shows "was due" with the original time and a **Run now** button. Run it, edit it to a new time, or delete it.

## Telegram messages

If you set up a Telegram bot in **Settings**, **Notifications**, **Telegram bot** and fill in **Scheduled tasks chat/group ID**, Runova posts a message there for every new scheduled task. It shows the project, target AI, CLI, when it runs and its status, followed by the prompt. As the task changes (completed, cancelled, missed, moved to a new time) the same message is edited, so the chat keeps one up to date card per task instead of a stream of messages.

If the bot token or the scheduled tasks chat ID is missing, the task is still created and no message is sent. See [Notifications and Telegram](notifications-telegram.md).

## Tips

- Pick **Manually** for a prompt you want ready but not running by itself. It waits in **Up next** until you click **Run now**.
- To run something overnight, make sure the computer will not sleep. The **Keep computer awake** control in the status bar at the bottom of the window has an **On** mode that keeps it awake continuously. The default **Agent** mode only holds it awake while an agent or command is already running.
- If a task keeps showing **Missed**, Runova was probably closed at that time. Reschedule it with **Edit**.

## Related

- [Projects](projects.md)
- [Prompt Builder](prompt-builder.md)
- [Notifications and Telegram](notifications-telegram.md)
- [Settings](settings.md)
- [AI CLI Manager](cli-manager.md)
