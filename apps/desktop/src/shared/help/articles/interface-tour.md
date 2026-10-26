---
title: Interface tour
category: Getting started
order: 20
summary: A tour of the Runova window, covering the sidebar or top menu, title bar, back and forward buttons, header buttons, status bar, version and updates, messages, themes and quitting.
keywords: interface, layout, sidebar, top menu, menu bar, title bar, status bar, back forward, toast, recent messages, bell, update, check for updates, version, theme, glass, quit, loading, github account, gh, relay, pause run, macos update, rosetta, apple silicon, arm64
---

The Runova window has the same few parts on every page: a title bar across the top, the main menu (a sidebar on the left or a bar along the top), a header with the page title and a few buttons, the page itself, and a status bar along the bottom. This article explains what each part does and how to change the ones you can.

## Where to find it

These parts are always on screen. The settings that change them are under **Settings**, on the **General** tab, in the **Appearance** card (theme and menu position) and the **Startup page** row.

## The main menu: sidebar or top bar

The main menu lists every page of the app. It comes in two layouts that show exactly the same entries.

### Sidebar (the default)

The sidebar runs down the left edge. At the top are **Dashboard**, **Workspace** and **Projects**. Below them are four headed groups: **Build**, **Agents**, **Ship** and **Connect**. **Settings** and the version card are pinned to the bottom. The current page is highlighted.

Two small signals appear on menu entries:

- **Pipelines** shows a red count of unread pipeline results (99+ when there are more than 99).
- **Workspace** shows a dot when an agent needs attention. The dot is amber when an agent is waiting for your input and in the main color when one has finished.

The button at the left of the header folds the sidebar. Each click moves to the next state: full labels, then icons only (a narrow rail where each icon has a tooltip), then hidden completely so the page gets the whole width. Click again to start over. Its tooltip reads **Collapse sidebar**, **Hide sidebar** or **Show sidebar** depending on the current state. Runova remembers the state between launches.

### Top menu bar

The top menu bar runs under the title bar. **Dashboard**, **Workspace** and **Projects** are tabs. Each group, **Build**, **Agents**, **Ship** and **Connect**, becomes a dropdown that lists its pages. **Settings** is at the right end, next to the version chip. A group's trigger shows a small red dot when it contains unread pipeline results, and the group of the current page is highlighted. On a narrow window the tabs scroll sideways instead of wrapping.

With the top bar there is no sidebar to fold, so the fold button is not shown.

### Switch between them

1. Open **Settings**, **General** tab.
2. In the **Appearance** card, find **Main menu**.
3. Choose **Left** (a sidebar down the left edge) or **Top** (a menu bar under the title bar).

The change applies straight away.

## The title bar

The title bar holds the Runova icon and name on the left, the search box in the middle with the back and forward buttons beside it, and the window controls.

- **Search box.** It reads "Search projects, history, skills…" and shows the shortcut (`Ctrl+K`, or `Cmd+K` on macOS). Click it to open the command palette. See [Command palette and search](command-palette-search.md).
- **Window controls.** On Windows and Linux the **Minimize**, **Maximize** (or **Restore**) and **Close** buttons are at the right. On macOS the red, yellow and green traffic lights are at the left.
- **Double-click.** Double-clicking an empty part of the title bar maximizes the window or restores it. You can drag the window by the title bar.

### Back and forward

The two arrows next to the search box move through the pages you have visited, like a browser. They are greyed out when there is nowhere to go.

| Action | How |
| --- | --- |
| Back | The left arrow, `Alt+Left`, `Cmd+[` on macOS, or the back thumb button on a mouse |
| Forward | The right arrow, `Alt+Right`, `Cmd+]` on macOS, or the forward thumb button on a mouse |

## The page header

Under the title bar (and under the top menu, if you use it) each page shows its title, with a smaller line of description below it. A project's page shows the project name and its agent type.

At the right end of the header are buttons that work on every page:

- **Toggle terminal** opens or closes the general terminal drawer, a shell for running your app, installs and so on. It shows a dot when terminals are open, and a pulsing amber dot when an AI task in a terminal is waiting for you. The shortcut is `Ctrl+T` or `` Ctrl+` `` (`Cmd` on macOS). Besides terminals, the drawer can hold a tab with a server's SFTP files, so a long transfer stays in view on every page. See [SSH files](ssh-files.md#show-the-files-in-the-bottom-panel).
- **Recent messages** (the bell) opens the message history. See below.
- **Ask AI** opens the Ask AI chat as a pop-up. See [Ask AI](ask-ai.md).
- On the Workspace page, extra buttons for the project on screen appear here too. See [Workspace](workspace.md).
- While an update is downloading in the background, a small chip with the version and percentage appears here. See below.

## The status bar

The strip along the bottom of the window shows what is running. The left side is about agents, and the right side is about your machine. Items that do not apply are hidden, for example Docker when Docker is not installed. Most items open a small panel when you click them.

### On the left: agents

- **No agents running** is shown when nothing is open. Clicking it opens the Workspace.
- When agents are running in Workspace tabs, they are grouped by state: **N waiting on you**, **N working**, **N finished**, and **N idle**. Click a group to see its agents, then click one to jump to its tab.

### On the right

| Item | What it shows |
| --- | --- |
| Relay | Only while a [relay](relay.md) is running or waiting to start. It shows the task on the move (such as `T003`), how many tasks are done out of all of them, and how full the session's context is. It turns amber when a task is waiting for you, and a `+1` means another relay is live. Click it to open the task board. |
| Project runs | Projects started with **Run**. A single run shows its name and the port it listens on (or the device it went to), plus its CPU and memory. A run that listens on several ports shows the first, with a `+1` for each other. More than one run collapses into a count such as "2 runs". A paused run reads **paused** instead of its CPU. The panel lists each run with its web addresses (click one to open it, or use its copy button) and the buttons **Show terminal**, **Pause** or **Resume**, and **Stop**. With two or more runs it also has **Pause all** and **Resume all**, and a switch, **Pause runs while an agent works**. See [Pause a run](projects.md#pause-a-run). |
| File transfers | Uploads and downloads in the [SSH file manager](ssh-files.md#the-status-bar), like "2 transfers 48%", or **Needs your answer** when a file already exists at the target. The panel lists each transfer with a cancel button, an **Answer** button for a waiting question, and **Open file manager** and **Show in panel** for each server. Hidden while nothing moves and nothing waits. |
| Terminals | The number of open terminals, for example "3 terminals". Click it to open the **Running CLIs** dialog, which shows CPU and memory for every terminal. |
| Plan limits | One item each for Claude Code, Codex and Cursor when the account reports plan limits, showing the percentage used of the next limit to reset and a countdown. If the account cannot be read, the item stays: it shows the last reading, dimmed with a warning icon, or for Claude Code an estimate from your local logs marked with a `~`. The panel lists that provider's limits, has a **Refresh** button for it, and **Open Token Usage** goes to [Token Usage](token-usage.md#the-status-bar). Each one can be turned off under **Status bar limits** in [Settings](settings.md#status-bar-limits). |
| GitHub account | The account the GitHub CLI (`gh`) is signed in as, shown as `@login`, or **Not signed in**. The panel shows the name, the organizations you belong to, **Open profile** and **Use another account**, which opens a terminal with `gh auth login` typed in (press `Enter` there). The refresh button checks the sign-in again, and a login finished in your browser shows up within seconds. If the check fails, for example when you are offline, the item keeps the last account, dimmed with a warning icon, instead of saying you are signed out. Hidden when `gh` is not installed. |
| Docker | "N running" containers. The panel lists up to eight, and **Open the Docker page** goes to [Docker](docker.md). Hidden when Docker is not available. |
| Android | "N running" emulators. The panel lists them with their memory and CPU. **Open the Android page** goes to [Android](android.md). Hidden when no Android SDK is found. |
| CPU | Current CPU use with a meter. The panel adds a chart, per-core bars, the busiest apps and any GPU. |
| Memory | Memory in use out of the total, with a meter. The panel adds a chart, In use, Free and Total, and the heaviest apps. |
| Network | Latency in milliseconds (or **Online**, **No ping**, **Offline**). It is green, amber or red. Hover to see each ping target and its latency. |
| Keep computer awake | **On**, **Agent** or **Off**. See below. |

The network figure comes from the ping targets you can edit under Settings, Network, **Network ping targets**. See [Dashboard](dashboard.md).

### Keep computer awake

Click the **Keep computer awake** item and choose one of three modes:

- **On** keeps the computer awake all the time.
- **Agent** keeps it awake while an agent or a command is running. The panel says what is holding it awake, such as an agent at work, a command in a terminal, an SSH session or file transfers.
- **Off** allows normal sleep.

## Version, about card and updates

At the bottom of the sidebar, the about card shows the Runova icon, "Runova by SmartClouds" and the running version. In the top menu layout the version chip at the right end does the same job. With the narrow icon rail, only the icon is shown, with the details in its tooltip. A small dot on the card means an update is waiting.

Click the card (or chip) to check for updates. If you are current, a message says "You're on the latest version." If a newer version exists, the update dialog opens.

### How updates work

Runova checks for updates on its own when it starts and then about every hour, but only in an installed build (a development build shows "dev" as its version and does not check). Nothing is downloaded and nothing restarts without you clicking.

The update dialog changes as the update moves along:

| Stage | What you see | Buttons |
| --- | --- | --- |
| New version found | **Update available**, with the version, size and release notes. If part of a download is already saved, it reads **Finish downloading update**. | **Later**, **Download** (or **Resume download**) |
| Downloading | A percentage, a progress bar, speed and time left. The download keeps going if you hide the dialog. If the connection drops it says **Reconnecting** and keeps the bytes already saved. | **Hide**, **Pause** |
| Paused | **Download paused** with the progress so far. | **Hide**, **Resume download** |
| Ready | **Update ready to install**. It installs the next time you quit, or right now if you restart. | **Later**, **Restart now** |
| Problem | **Download interrupted** (it can resume) or **Update failed**. | **Hide**, then **Resume download** or **Try again** |

If you hide the dialog while a download is running, paused, finished or interrupted, a small chip stays in the page header showing the version (or **Paused**, **Ready**, **Interrupted**, **Resume**) and the percentage. Click the chip to bring the dialog back.

**Restart now** turns into **Restarting...** and both buttons are greyed out while Runova hands over to the installer. If that fails, a message says "Restart to install failed. Quit the app and it installs on the way out." and the update still installs when you quit.

### Updates on macOS

The macOS builds are not signed with an Apple Developer ID, so the system's own updater cannot install them. Runova does it itself: it unpacks the new version next to the app, quits, swaps the app for the new one and opens it again. Two things can stop it, and both come with a message:

- **"macOS is running Runova from a temporary copy."** The app was opened straight from a downloaded disk image or zip. Move Runova to the Applications folder, open it from there, and update again.
- **"Runova can't write to (folder), so it can't replace itself."** Your account cannot change the folder the app is in. Download the new version from the releases page instead.

On a Mac with an Apple Silicon chip, updates always bring the Apple Silicon (arm64) version. If you are running the Intel version through Rosetta, a notice titled **Install the Apple Silicon version** appears when the window opens. Git and the built-in terminals fail under Rosetta with "missing compatible architecture". **Open releases page** takes you to the download, and you drag the new app over the old one in Applications. Your projects and settings are kept. Tick **Don't show this again** to stop the notice, otherwise it comes back each launch. The next update switches you over by itself.

You can also check and manage updates from **Settings**, **Data** tab, in the **About** card. It shows the same status line, the progress bar and the same actions: **Check for updates**, **Download**, **Pause**, **Resume download**, **Show** and **Restart now**.

## Messages, toasts and the message history

Short alerts appear in the bottom right corner of the window as toasts. They have a close button and fade on their own. Success, error, warning and info messages all use the same frosted look, with a colored accent.

If you miss one, click **Recent messages** (the bell) in the header. A panel slides in from the right, titled **Recent messages**, with the alerts that flashed in the corner. Runova also puts pipeline results and CLI update notices here.

- The bell shows a dot when there are messages you have not seen. The dot turns red if any unread one is an error. Opening the panel marks everything as read.
- Messages are grouped by day. If the same message repeats back to back, it collapses into one entry with a count such as ×3.
- Use the filter buttons **All**, **Errors**, **Warnings**, **Success** and **Info**, or the **Search messages…** box, to narrow the list.
- On a message, click **Show again** to replay it as a toast, or **Remove** (visible on hover) to delete it. A message that links somewhere, such as a pipeline run, opens that page when you click the row.
- Click **Clear history** at the bottom, then **Clear all** to confirm, to empty the list. The list keeps the latest 80 messages and is remembered between launches.

You can also open the panel from the command palette by choosing **Recent messages**.

## Themes and the glass window

### Themes

Open **Settings**, **General** tab, **Appearance** card. Click one of five themes and it applies immediately:

| Theme | Description |
| --- | --- |
| **Light** | Bright canvas |
| **Dark** | Near-black canvas |
| **System** | Follow this machine |
| **VS Code Dark** | Blue accent, editor-inspired |
| **VS 2026** | Violet accent, modern IDE |

**System** switches between light and dark by itself when your operating system does.

### Glass

On Windows 11 (version 22H2 or newer) the window uses the Mica material, and on macOS it uses the system's translucent vibrancy, so the title bar, menu and status bar blend with your desktop. On Windows 10 and Linux the window uses the theme's solid color. This is automatic and there is no setting for it. Pop-up windows such as widgets and the desktop pet stay solid.

## Closing the app

Closing the window or quitting while a CLI, SSH connection or Remote Desktop session is still open asks first. The dialog is titled **Close Runova?** and lists what is open, for example "You still have 2 CLI sessions open." The text under it depends on your **Keep terminals running** setting (Settings, General):

- With it on, CLI sessions keep running in the background and are ready when you reopen the app, while server connections are closed.
- With it off, closing the app stops the CLI sessions and disconnects from every server.

Click **Close app** to quit or cancel to stay. If nothing is open, the app closes without asking. Restarting to install an update never asks, and it keeps your terminals running.

## Loading states

When Runova starts, the splash window covers the wait, and the first page then loads behind it. If that first load is slow, a glass overlay with the Runova logo and a spinning ring covers the page. After that, pages do not blank out while loading. Each card shows a shimmering placeholder in its own place until its data arrives. A save that has to block the page can briefly bring the overlay back.

If a page crashes, the rest of the window keeps working. The menu stays usable and the error is shown in place of the page.

## Tips

- The Workspace keeps its terminals running while you visit other pages.
- Moving the menu to the top is handy on small screens or when a page has wide tables.
- Press `F1` for the Help page. See [Help center](help-center.md).

## Related

- [Getting started](getting-started.md)
- [Command palette and search](command-palette-search.md)
- [Dashboard](dashboard.md)
- [Settings](settings.md)
- [Keyboard shortcuts](keyboard-shortcuts.md)
- [Notifications and Telegram](notifications-telegram.md)
- [Troubleshooting](troubleshooting.md)
