---
title: Getting started
category: Getting started
order: 10
summary: What Runova is, how the app is laid out, and the first steps to take after installing it, from picking a projects folder to opening your first Workspace.
keywords: getting started, first steps, runova name, formerly agentmate, rename, runway, nova, setup, install, overview, tour, projects folder, startup page, splash, ai provider, ai cli, claude code, codex, welcome, beginner, sidebar, menu, quick start
---

Runova is a desktop app for working with AI coding agents. It keeps your projects, agent terminals, prompts, git, deployments and servers in one window, so you can start an agent such as Claude Code or Codex in a project, watch what it does, review its changes and ship the result without leaving the app.

The name joins a runway, where launches happen, and a nova, a new star: you bring an idea, the agents build it with you, and it takes off from here. Runova used to be called AgentMate. Updating from it moves your settings, projects, saved secrets and servers over on its own, and see [Troubleshooting](troubleshooting.md) if something from before seems to be missing.

This article walks through what is in the app and the handful of things worth doing the first time you open it. Every other area has its own article, linked along the way.

## Where to find it

You are already here. To come back to this page later, press `F1` to open the in-app Help, or open the command palette (`Ctrl+K`, `Cmd+K` on macOS) and type Help. The Help page has a search box and an **Ask the guide** chat that answers from these articles once an AI provider is set up. See [Help center](help-center.md).

## What Runova is made of

The app is organised around a menu with a few pages at the top and four headed groups below them. By default the menu is a sidebar down the left edge. You can move it to a bar along the top in Settings, General, **Main menu**. Both layouts show the same pages. See [Interface tour](interface-tour.md) for the details.

### The pages at the top of the menu

| Page | What it is for |
| --- | --- |
| **Dashboard** | Your AI CLIs, projects and system health at a glance. See [Dashboard](dashboard.md). |
| **Workspace** | Terminals, agents, files, git and a browser side by side for one project. See [Workspace](workspace.md). |
| **Projects** | The list of projects you work on, and each project's own page. See [Projects](projects.md). |

### Build

| Page | What it is for |
| --- | --- |
| **Prompt Builder** | Turn a rough request into a clear prompt for an AI tool. See [Prompt Builder](prompt-builder.md). |
| **Ask AI** | Chat with an AI model you have set up. See [Ask AI](ask-ai.md). |
| **API Client** | Build and send HTTP requests. See [API Client](api-client.md). |

### Agents

| Page | What it is for |
| --- | --- |
| **AI CLI Manager** | See which AI coding CLIs are installed and install the missing ones. See [AI CLI Manager](cli-manager.md). |
| **Skills** | Find and install skills for your agents. See [Skills](skills.md). |
| **MCP Servers** | Install MCP servers that give agents extra tools. See [MCP Servers](mcp-servers.md). |
| **Agent Tools** | Install helper tools such as code reviewers and security scanners. See [Agent Tools](agent-tools.md). |
| **Token Usage** | Track tokens, cost and limits across your AI providers. See [Token Usage](token-usage.md). |

### Ship

| Page | What it is for |
| --- | --- |
| **Pipelines** | Watch GitHub Actions runs. See [Pipelines](pipelines.md). |
| **Deploy** | Set up servers, containers, sites and certificates. See [Deploy](deploy.md). |
| **Docker** | Manage containers on this machine. See [Docker](docker.md). |
| **Android** | Manage the Android SDK, emulators and devices. See [Android](android.md). |

### Connect

| Page | What it is for |
| --- | --- |
| **Remote** | SSH servers, remote desktop and remote files. See [Remote](remote.md). |
| **Vault** | A password manager for logins and API keys. See [Vault](vault.md). |

**Settings** sits apart from the groups: at the bottom of the sidebar, or at the right end of the top bar. See [Settings](settings.md).

## First steps

None of these is required, and you can do them in any order, but together they get you from a fresh install to an agent working in a project.

### Set the projects folder

The projects folder is where file pickers open by default, so you do not have to browse from the system default every time.

1. Open **Settings** and stay on the **General** tab.
2. Find the **Projects folder** card.
3. Type a path, or click **Browse…** and pick the folder where your code lives.
4. Click **Save changes** in the bar that appears at the bottom of the page.

Leave it empty to use the last location your system dialog remembered.

### Add an AI provider

An AI provider is what powers Ask AI, Prompt Builder and the Help chat. Runova supports OpenAI, Gemini and Ollama (a model running on your own machine).

1. Open **Settings** and click the **AI** tab.
2. In the **Providers** card, find OpenAI, Gemini or Ollama.
3. For OpenAI or Gemini, paste your API key and set a default model. For Ollama, enter the **Server URL** (for example `http://localhost:11434`) and pick a model.
4. Click **Save changes**.

The badge next to each provider says **Key set** or **No key**. For the full list of providers, models and checks, see [AI providers](ai-providers.md).

Separately, the **Agents** tab of Settings has a **Default CLI** card. That picks which AI CLI Runova starts when a feature needs one without asking you.

### Install or detect your AI CLIs

AI CLIs are the command line agents themselves, for example Claude Code, Codex and Gemini CLI. Runova detects the ones already on your machine.

1. Click **AI CLI Manager** in the menu, under Agents.
2. Check which CLIs are detected. If you have some not installed, click **Show all CLIs** to see them.
3. Install a missing CLI from its card.

The Dashboard also shows how many CLIs are installed and tells you when an installed CLI or tool has an update. See [AI CLI Manager](cli-manager.md).

### Add a project

A project is a folder on your computer that Runova knows about.

1. Click **Projects** in the menu, then **New Project**. From the Dashboard you can click **New Project** too.
2. On the **Basics** tab, enter a **Name** and choose the **Folder**. These two are required. If you pick the folder with **Browse** and the name is still empty, the name fills in from the folder name.
3. Optionally set the agent type, tags, an icon and run commands on the other tabs. You can change all of it later.
4. Click **Create project**, or press `Ctrl+Enter`.

Runova reads the folder's git remote if there is one and fills in the **Git repository** field for you. See [Projects](projects.md) for every field.

### Open the Workspace

The Workspace is where you actually run agents.

1. Open a project from the Projects page.
2. Click **Open workspace** in its header. You can also click **Workspace** in the menu.
3. Start a terminal or an agent in a pane and begin working.

See [Workspace](workspace.md), [Terminals and agents](workspace-terminals-agents.md) and [Git in the Workspace](workspace-git.md).

## The startup splash

When you launch Runova, a small glass window appears first while the app loads. It shows the Runova logo, the tagline "Agentic Development Environment", a progress bar, and a line saying what it is busy with, for example "Loading settings...", "Starting services..." and "Loading your workspace...". In the bottom right corner it shows the maker (SmartClouds), the year and the version (or "Dev build" when you run a development build).

The splash goes away on its own as soon as the first page has its data, and the main window appears in its place. If the main window takes unusually long, Runova shows it anyway after about 15 seconds so you are not left waiting.

## The startup page setting

You choose which page Runova opens on.

1. Open **Settings** and stay on the **General** tab.
2. Find the **Startup page** row.
3. Pick **Last opened page**, or any page from the menu, such as Dashboard or Workspace.

**Last opened page** is the default. It brings back the page and project you were on, whether you closed the app, it restarted to install an update, or the computer shut down. If that page belonged to a project you have since deleted, Runova opens the Projects or Workspace page instead. On the very first launch, with nothing to restore yet, it opens on the Dashboard.

## Tips

- Press `Ctrl+K` (`Cmd+K` on macOS) any time to jump to a page, a project or a skill by typing a few letters. See [Command palette and search](command-palette-search.md).
- If you prefer more width for your pages, switch the menu to the top in Settings, General, **Main menu**.
- If something does not work as expected, see [Troubleshooting](troubleshooting.md).

## Related

- [Interface tour](interface-tour.md)
- [Command palette and search](command-palette-search.md)
- [Dashboard](dashboard.md)
- [Projects](projects.md)
- [Workspace](workspace.md)
- [Settings](settings.md)
- [AI providers](ai-providers.md)
- [Keyboard shortcuts](keyboard-shortcuts.md)
- [Help center](help-center.md)
