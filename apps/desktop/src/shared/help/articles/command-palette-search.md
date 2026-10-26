---
title: Command palette and search
category: Getting started
order: 30
summary: Jump to any page, project, prompt, skill or Vault entry from one search box, and search a project's files, types, members and text from the Workspace.
keywords: command palette, search, ctrl+k, cmd+k, quick open, go to, find, workspace search, ctrl+p, files, symbols, text search, regex, wildcard, glob, pattern, global shortcuts
---

Runova has two search tools. The command palette is a quick way to jump anywhere in the app: pages, projects, worktrees, prompt history, skills and Vault entries. Workspace search is a bigger dialog inside the Workspace that finds files, types, members and text inside one project's code, with a preview of each result.

## Where to find it

For the command palette, click the search box in the middle of the title bar ("Search projects, history, skills…") or press `Ctrl+K` (`Cmd+K` on macOS). Pressing the shortcut again closes it.

For Workspace search, open a project's Workspace and press `Ctrl+P` (`Cmd+P` on macOS). See [Workspace search](#workspace-search) below.

## The command palette

The palette opens right over the title bar's search box, so it looks as if the box grows downward with the results. Start typing and the list narrows to the matches. Matching looks at names and also at extra words such as a project's folder path, description and tags.

### What the palette lists

Before you type anything it shows these groups, and typing filters all of them.

| Group | What is in it |
| --- | --- |
| **Go to** | Every page in the menu (Dashboard, Workspace, Projects, Prompt Builder, Ask AI, API Client, AI CLI Manager, Skills, MCP Servers, Agent Tools, Token Usage, Pipelines, Deploy, Docker, Android, Remote, Vault, Settings), plus **Recent messages**, which opens the message history, and **Running CLIs**, which opens the dialog with CPU and memory for every terminal. |
| **Vault** | Shown once you have set up a Vault. While the Vault is locked, a single **Unlock Vault** entry takes you to the Vault page. While it is unlocked, there is a **Lock Vault** entry and one entry per saved item, shown by title. Choosing an item opens it in the Vault. Nothing is listed if the Vault has not been created yet. |
| **Projects** | Every project, with its name and folder path. Choosing one opens its project page. |
| **Prompt History** | Your earlier prompts and translations. Choosing one opens it in Prompt History. |
| **Skills** | Skills from your skill repositories. Choosing one opens the Skills page filtered to that skill. |

Some entries appear only once you start typing:

- **Open workspace.** Entries like "Workspace: My App" for every project that is not archived. They open that project's Workspace directly.
- **Worktrees.** Git worktrees of the projects open in the Workspace rail, shown as the project name and branch. Choosing one opens that worktree's Workspace. When a project's Workspace is on screen, a "New worktree of ..." entry lets you create one.

### Using the palette

1. Press `Ctrl+K` (`Cmd+K` on macOS).
2. Type a few letters. The best match is highlighted.
3. Press `Enter` to open the highlighted entry, or use the up and down arrow keys to pick another and then `Enter`. You can also click an entry.
4. Press `Esc`, or `Ctrl+K` again, to close it without choosing.

If nothing matches, the palette says **No results found.** The text you typed is cleared when the palette closes, so the next time you open it you start fresh.

> [!TIP]
> To reach a page fast, type just a few letters of its name, for example "vault" or "docker", and press `Enter`.

## Workspace search

Workspace search is a large dialog for finding things in the code of one project. It opens on the project whose Workspace is on screen, and it remembers the last search you typed for each project, so reopening it picks up where you left off.

### Open and close it

- Press `Ctrl+P` (`Cmd+P` on macOS) while a project's Workspace is showing. Pressing it again while the dialog is open selects the text in the box so you can start a fresh search.
- You can also open it from the file search box in the Workspace Files panel. Its **Search files and code** button, and the **Search in file contents for ...** row under the results, hand what you typed over to the dialog.
- Press `Esc` or click the close button to leave.

`Ctrl+P` goes to the Projects page everywhere else in the app. On the Workspace it opens search instead. You can change either key in Settings, Shortcuts. See [Keyboard shortcuts](keyboard-shortcuts.md).

### Patterns in the Files panel search box

The search box in the Workspace Files panel also takes patterns, so you can list files by shape instead of by name:

- `*.md` lists every Markdown file in the project, in any folder. `*` stands for any run of characters inside one folder name, and `?` for exactly one character.
- `docs/*.md` lists the Markdown files directly inside any `docs` folder. `docs/**/*.md` also goes into the folders below it.
- Put a regular expression between two slashes for anything a wildcard cannot say, for example `/\.test\.tsx?$/` for test files. It is matched against the whole path and ignores case.

Anything else is searched by name as before. If a regular expression is not valid, the box says so instead of showing an empty list. The full Workspace search dialog does not read these patterns.

### What you can search for

The row of tabs above the box picks what to search for. The tab you choose is shown as a short prefix in the box, and you can type the prefix yourself instead.

| Tab | Prefix | What it finds |
| --- | --- | --- |
| **All** | none | Files, types, members and text together, in sections. Each section shows the first few results and a **See all N** row that switches to that tab. |
| **Files** | `f:` | Files by name or path. |
| **Types** | `t:` | Classes, interfaces, structs, enums, type aliases, records, traits and namespaces, found by their declaration. |
| **Members** | `m:` | Functions, methods, constructors, properties, fields and constants, found by their declaration. |
| **Text** | `x:` | The text inside files. |

Each tab can show a count of matches. Press `Tab` to move to the next tab and `Shift+Tab` for the previous one. When the box is empty on the **All** or **Files** tab, it lists your recent files for that project.

### Jump to a line

On the **All** and **Files** tabs, add a line to a file name to open the file at that line:

- `app.ts:42` opens line 42.
- `app.ts:42:7` opens line 42, column 7.
- `app.ts(42)` also opens line 42.

A path that starts with a drive letter and a slash, such as `f:\src`, is read as a path, not as the Files prefix.

### Text search options

At the right end of the box are three toggles. Each can also be flipped with a key.

| Toggle | Key | Effect |
| --- | --- | --- |
| **Match case** (`Aa`) | `Alt+C` | Treats upper and lower case as different. |
| **Match whole word** (`ab`) | `Alt+W` | Matches only whole words. |
| **Use regular expression** (`.*`) | `Alt+R` | Reads what you typed as a regular expression instead of plain text. |

The choices are remembered. Text search waits for a short pause in typing, and in the **All** tab it starts after three characters (two in the **Text** tab). It respects `.gitignore`, searches hidden files, skips `.git` and `node_modules`, and skips files larger than 2 MB. Each file shows at most 100 matches, and a whole search stops at 2000 matches, with the footer saying that only the first are shown.

The **Types** and **Members** tabs read declarations in TypeScript and JavaScript, Python, Go, Rust, C#, Java, Kotlin, Swift, PHP and C and C++ files. If a project is very large, the footer notes that some files or declarations were left out.

### Open a result

| Key | What it does |
| --- | --- |
| `Up` and `Down` | Move through results. |
| `PageUp` and `PageDown` | Move ten results at a time. |
| `Enter` | Opens the file (at the right line, when the result points to one) as a pinned tab and closes the dialog. |
| `Shift+Enter` | Opens it as a preview tab and keeps the dialog open, so you can look at several results in a row. |
| `Ctrl+Enter` (`Cmd+Enter`) | Splits the pane and opens the result to the side. |

You can also click a result. File results show their git status letter when the file has changes, and type and member results show a small badge for the kind, such as C for class or ƒ for function.

### The preview

The lower part of the dialog previews the selected result with the matching line in view. Click the eye button in the tab row to hide or show the preview, and drag the handle between the list and the preview to resize it. For pictures, a button in the preview turns **Hide picture previews** on, which stops the dialog reading image files at all and is useful in projects with large assets. The dialog remembers the preview size and visibility.

## Global shortcuts

A few shortcuts work on every page of the app. The defaults below use `Ctrl`, and on macOS the app uses `Cmd` instead. Change any of them in Settings, **Shortcuts** tab.

| Shortcut | What it does |
| --- | --- |
| `Ctrl+K` | Opens or closes the command palette. |
| `Ctrl+P` | Goes to the Projects page. On the Workspace it opens Workspace search instead. |
| `Ctrl+T` or `` Ctrl+` `` | Opens or closes the terminal drawer. |
| `` Ctrl+Shift+` `` | Starts a new terminal tab in the drawer. |
| `Shift+F5` | Stops the project run in the drawer, or the newest run if none is showing. |
| `Alt+Left` and `Alt+Right` | Go back and forward through visited pages (`Cmd+[` and `Cmd+]` on macOS also work). |
| `/` | On the Projects page, focuses the project search box. |

Global shortcuts pause while a dialog that uses the same keys is open. For example, `Ctrl+P` does not jump to Projects from behind an open dialog, and in the Prompt Builder `Ctrl+T` translates instead of toggling the terminal. The Workspace, Prompt Builder, commit box and Vault have their own shortcuts. See [Keyboard shortcuts](keyboard-shortcuts.md).

## Tips

- The title bar search box and `Ctrl+K` open the same palette.
- Use `Ctrl+P` in a project to open a file by name in a couple of keystrokes, the way editors do.
- Start a search with `x:` when you only want text matches, or `t:` to jump straight to a class.
- If a search finds nothing in a file you expect, check that it is not ignored by `.gitignore` or larger than 2 MB.

## Related

- [Getting started](getting-started.md)
- [Interface tour](interface-tour.md)
- [Workspace](workspace.md)
- [Workspace files and editor](workspace-files-editor.md)
- [Projects](projects.md)
- [Vault](vault.md)
- [Keyboard shortcuts](keyboard-shortcuts.md)
