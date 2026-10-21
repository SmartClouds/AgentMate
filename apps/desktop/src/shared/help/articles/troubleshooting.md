---
title: Troubleshooting and FAQ
category: Troubleshooting
order: 10
summary: Fixes for common problems such as AI provider errors, CLIs that are not detected, terminals that will not start, Docker, SSH host keys and failed updates, plus where AgentMate keeps its data and a short FAQ.
keywords: troubleshooting, problem, error, fix, not working, help, faq, ollama not reachable, api key, timeout, cli not detected, not installed, terminal won't start, docker not available, host key changed, rosetta, intel, apple silicon, missing compatible architecture, gh not found, clone failed, update failed, reset, data folder, userData, logs, proxy
---

This page lists the problems people run into most, with the exact messages AgentMate shows and what to do about each one. If your problem is not here, use the **Ask the guide** chat on the Help page (press `F1`), which answers from these articles when an AI provider is set up. See [Help center](help-center.md).

## Where to find it

Press `F1`, or click **Help** in the menu or the command palette, and open **Troubleshooting and FAQ**. Many errors also appear as messages in the corner. The bell in the header (**Recent messages**) keeps them for a while if you missed one.

## AI provider errors

These come from Ask AI, Prompt Builder and the other features that call OpenAI, Gemini or Ollama directly. Setup is in [AI providers](ai-providers.md).

| Message | What to do |
| --- | --- |
| Set an OpenAI API key in Settings first. | Open **Settings**, **AI**, **Providers**, paste the key under **OpenAI**, and click **Save changes**. |
| Set a Gemini API key in Settings first. | Same, under **Gemini**. |
| Choose an Ollama model first. | Pick a **Default model** under **Ollama** in Providers, or choose a model on the Ask AI page. |
| Could not reach Ollama at (address). Is it running? | Ollama is not answering at that address. See below. |
| OpenAI request failed with status 401 (or another number) | OpenAI refused the request. A 401 usually means a wrong or revoked key. When OpenAI sends its own explanation, AgentMate shows that text instead. |
| No answer after 3 minutes (10 for Ollama), so the request was stopped. | The provider took too long. Check your internet connection and [proxy](settings.md#proxy), then try again. A large local model can need a long time to load and answer on a slow computer, so try a smaller model. |
| Request cancelled. | You pressed stop. |

### Ollama is not reachable

1. Make sure Ollama is installed and running on the machine whose address you set. The default address is `http://localhost:11434`.
2. In **Settings**, **AI**, **Providers**, click **Test connection** under **Ollama**. A **Connected** badge with the version means it works, **Not reachable** means it does not.
3. If it says "Connected, but no models are installed", run `ollama pull` with a model name in a terminal, then click the refresh button next to **Default model**.
4. If Ollama runs on another computer, type its address in **Server URL**. If you use a proxy, remember that the proxy's **Skip the proxy for** list should include local addresses (`<local>` does).

### The guide answers from keyword search only

With Ollama, the **Ask the guide** chat needs an embedding model on your server to search by meaning. If it is missing, the answer carries a note that it came from keyword search only, and **Settings** > **AI** > **Help search** marks the model **(not installed)**. Run `ollama pull` with the model name shown there (by default `nomic-embed-text`), then click **Update index**. See [Help center](help-center.md#choose-the-search-model).

### CLI answers fail

When a helper runs an agent CLI in the background, you may see "(CLI) was still working after N minutes and was stopped", "(CLI) exited without answering", or "(CLI) can't look at screenshots". Pick another CLI for that task, or check that the CLI is installed and signed in by running it once in a terminal.

## An AI CLI is not detected

[AI CLI Manager](cli-manager.md) marks a CLI **Not installed** when it cannot find its program on your `PATH`.

1. Install it with the **Install** button on its card, or from the CLI's own instructions.
2. Click **Refresh** at the top of AI CLI Manager. It re-scans and skips the saved result.
3. If it is still missing, close and reopen AgentMate so it sees the updated `PATH`. A program installed to a folder that is not on your `PATH` will not be found.
4. If it shows as installed but the version looks slow to appear, wait. Some CLIs take over ten seconds to answer `--version`, and being slow does not make a CLI count as missing.

CLIs that are not installed are hidden by default. Click **Show all CLIs** to see them.

## Terminal problems

### The terminal will not start

A pane that says **Could not start this terminal.** failed to launch its shell. The line after it says why: a shell that is not installed (reinstall it, or pick another from the shell menu), or a folder that was deleted or moved (reopen the project from its new location). AgentMate writes the reason to its own console output, which a bug report can include.

### The session ended

A bar at the bottom of a tab says "Process exited" (with the exit code when it is not zero), or "This session ended while AgentMate was closed." Click **Restart** to start it again or **Close** to remove the tab.

### Terminals after quitting

With **Keep terminals running** on (the default), sessions keep going in the background after you quit and return when you reopen AgentMate. Turn it off in **Settings**, **General** if you want quitting to stop them. When you close the app with sessions open, AgentMate asks "Close AgentMate?" first and describes what will happen.

### Pasting and copying

`Ctrl+V` (or `Shift+Insert`) pastes, and `Ctrl+C` copies when text is selected and interrupts the program when nothing is. Right-click also copies a selection or pastes. See [Keyboard shortcuts](keyboard-shortcuts.md#fixed-keys-you-cannot-rebind).

### A shortcut does nothing

Workspace, Vault and prompt builder shortcuts only work on their own page. A shortcut that has been rebound shows the new keys in **Settings**, **Shortcuts**, and **Restore defaults** brings the original keys back.

## Docker is not available

The **Docker** page says **Docker isn't available** when it cannot get an answer from `docker version`. That happens when Docker is not installed, the `docker` command is not on `PATH`, or Docker Desktop is installed but not running.

1. Start Docker Desktop and wait until it says the engine is running.
2. If you use the Docker Engine CLI without Desktop, make sure its service is running.
3. Leave the Docker page and open it again. Once Docker answers, the container list appears and **Refresh** updates it.

See [Docker](docker.md).

## SSH host key changed

When you connect to a saved server and it shows a different host key from the one AgentMate trusted before, AgentMate stops and asks. The dialog is titled with the server's name and "identity changed", and shows **Trusted before** and **Presented now** fingerprints.

- A changed key is normal after you reinstall or replace the server. Compare the new fingerprint with the one on the server (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints it) or with your hosting provider, then click **Trust the new key**.
- If you did not reinstall or replace the server, treat it as a possible security warning and click **Don't connect**. That is the default button.
- If you decline, the connection fails with "its new host key was not trusted".
- In **Deploy**, background health checks never ask. Open the server's health card and click **Try again** to get the question.

A related message, "The vault is locked. Unlock it with your passkey first.", means the passkey that protects saved server passwords needs to be unlocked before the connection can use them. See [Remote](remote.md).

## Updates and settings

### Updates fail or stop

AgentMate checks for updates every hour and in **Settings**, **Data**, **About** with **Check for updates**. Updates download from the project's GitHub releases, and nothing downloads until you click **Download**.

- "Update checks are only available in installed builds, not in development." You are running from source.
- A message such as "Update check failed." or a network error: check your internet connection and the [proxy](settings.md#proxy), then click **Check for updates** again.
- "Download paused. What you already have stays on disk." Click **Resume download**. The download also resumes by itself if the connection drops, and what was downloaded is kept.
- "Downloaded file did not match the published checksum. The partial was discarded so the next try starts clean." The download was damaged. Click **Download** again.
- When it finishes, click **Restart now** to install. Terminals keep running through an update restart.
- "Restart to install failed. Quit the app and it installs on the way out." The hand-over to the installer did not start. Quit AgentMate and the update installs as it closes.
- On a Mac, "macOS is running AgentMate from a temporary copy." Move AgentMate to the Applications folder, open it from there, and update again. "AgentMate can't write to (folder), so it can't replace itself." means your account cannot change that folder, so download the new version from the releases page. See [Updates on macOS](interface-tour.md#updates-on-macos).

### Git says the Intel version of AgentMate is installed

"This Mac has an Apple Silicon chip, but the Intel version of AgentMate is installed, so git can't run." In the built-in terminals the same problem shows up as "missing compatible architecture". macOS runs the Intel version through Rosetta, and the developer tools it starts cannot run that way. Install the Apple Silicon (arm64) version: AgentMate shows an **Install the Apple Silicon version** notice at launch with a button to the releases page, and the next update switches you over by itself. Your projects and settings are kept. See [Updates on macOS](interface-tour.md#updates-on-macos).

### Clone or fetch says Git could not start the GitHub CLI

"Git could not start the GitHub CLI (gh) to sign in. Make sure gh is installed and on your PATH, then try again." Private GitHub repositories are cloned and fetched with your `gh` sign-in. Check that `gh --version` works in a terminal, and that `gh auth status` says you are signed in (`gh auth login` if not). If you just installed `gh`, close and reopen AgentMate so it sees the new `PATH`. Then use **Clone from GitHub** on the project's Git tab to try again, see [Projects](projects.md#git). The message "Repository not found" is different: it means the address is wrong or your account cannot see that repository.

### Settings does not load

If Settings shows "Could not load settings", click **Try again**. If it keeps failing, close AgentMate and check [where your data lives](#where-your-data-lives).

## Notification and Telegram problems

- **Telegram test fails:** "Configure your Telegram bot token and chat ID in Settings first." means one of them is empty. "Enter your Telegram bot token first." appears when you click **Detect from last message** with no token. "No messages found yet. Send your bot any message on Telegram, then try again." means the bot has not received a message. Other errors are Telegram's own description, for example when the token is wrong.
- **No system notifications:** make sure **Workspace notifications** or **Terminal AI notifications** is on, that your operating system allows notifications for AgentMate, and that you are not looking at the tab (nothing is shown for a tab you are on). See [Notifications and Telegram](notifications-telegram.md).
- **A scheduled prompt did not run:** AgentMate must be open at that time. A task more than 2 minutes late is marked **Missed**, and you can click **Run now**. See [Scheduled tasks](scheduled-tasks.md).

## Other common messages

| Message | What it means |
| --- | --- |
| Microphone access was blocked. Allow it to use voice input. | Allow the microphone for AgentMate in your system privacy settings. |
| No microphone was found. | Plug in or enable a microphone. |
| LanguageTool 6 needs Java 17 or newer | The local writing check needs a newer Java, or switch **Where checks run** to **LanguageTool online**. See [Writing, voice and translation](writing-voice-translation.md). |
| Pick a port between 1024 and 65535. | The LanguageTool port must be in that range. |
| Enter the proxy host. / Enter the proxy port. | A manual proxy needs both. See [Settings](settings.md#proxy). |
| No Android SDK found. | Set the SDK folder in **Settings**, **General**, **Android SDK**. |
| Could not read that file. / That file is not a valid AgentMate backup. | The file chosen for a restore is damaged or the wrong kind. See [Backup and restore](backup-restore.md). |

## Where your data lives

AgentMate keeps its data in your user data folder, which is named AgentMate. It is typically:

- Windows: `%APPDATA%\AgentMate`
- macOS: `~/Library/Application Support/AgentMate`
- Linux: `~/.config/AgentMate`

A copy running from source, a development build, is named AgentMate Dev and has its own folder. Setting the `AGENTMATE_USER_DATA_DIR` environment variable before starting the app points it at a different folder, which gives you a separate profile.

Inside the folder:

| Folder or file | What is in it |
| --- | --- |
| `data/` | Your settings (`settings.json`), projects, templates, drafts, scheduled tasks, blueprints, saved servers, the Vault file (`vault.json`), prompt history, window position and more. |
| `pets/` | The images of pets you added. |
| `tools/` | The LanguageTool download for the local writing check. |
| `whisper-models/` | The voice input model, once downloaded. |
| `skill-repo-cache/`, `mcp-repo-cache/` | Cached skill and MCP repositories. |
| `scratch/`, `pasted-images/` | Temporary files for prompts and pasted screenshots. |

Your project folders are not here. They stay wherever you created them, and AgentMate only stores a record of each one.

## How to reset

- **One setting group:** use the reset buttons on the card, such as **Restore defaults** for shortcuts, **Default order** for agents, **Reset to defaults** for review commands or **Reset to default** for ping URLs.
- **All settings:** export a backup first (it includes your saved keys). Quit AgentMate, then rename `settings.json` in the `data` folder. Settings fall back to their defaults on the next start. Your projects and everything else stay.
- **Everything:** export a backup, quit AgentMate, and move the whole AgentMate folder aside. AgentMate starts as if it were new. If you used **Keep terminals running**, turn it off first so no background terminal host is left running.
- **Forgot the Vault master password:** nothing in the Vault can be opened without it. **Settings**, **Vault**, **Reset vault** sets the old file aside and starts an empty Vault. See [Vault](vault.md).
- **Go back to a saved state:** restore a backup, see [Backup and restore](backup-restore.md).

## FAQ

### Do I need an AI provider to use AgentMate?

No. Terminals, agents and the Workspace work with the CLIs you install. An OpenAI key, Gemini key or Ollama server is only needed for Ask AI, Prompt Builder generation and translation, and the **Ask the guide** chat. See [AI providers](ai-providers.md).

### How do I open the Help page?

Press `F1`, click **Help** in the menu, or use the command palette. The page has a search box and the **Ask the guide** chat.

### Where do my project files go?

AgentMate does not move your files. A project points at a folder on your computer, and git, terminals and the editor work on that folder directly.

### Why does closing AgentMate ask "Close AgentMate?"

Because an agent CLI, SSH connection or Remote Desktop session is still open. The message says what closing will do to each. CLI sessions can keep running in the background if **Keep terminals running** is on.

### How do I move to a new computer?

Export a backup with project environments and the Vault, install AgentMate on the other computer and restore it. See [Backup and restore](backup-restore.md).

### How do I change the theme or move the menu to the top?

**Settings**, **General**, **Appearance**. Pick a theme, and choose **Left** or **Top** under **Main menu**.

### Where do my AI keys and Telegram token go?

They are stored in your settings on this computer. They are included in a backup file, so keep backups private. See [Settings](settings.md).

## Tips

- Read the message in the corner or in **Recent messages** first. AgentMate usually says what went wrong.
- After changing the proxy, reopen terminals that were already open. They keep the old setting until you do.
- When you report a problem, include the exact message and what you clicked.

## Related

- [Getting started](getting-started.md)
- [Settings](settings.md)
- [AI providers](ai-providers.md)
- [Backup and restore](backup-restore.md)
- [Keyboard shortcuts](keyboard-shortcuts.md)
- [Help center](help-center.md)
