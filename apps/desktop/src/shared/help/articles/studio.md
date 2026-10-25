---
title: Studio
category: Build
order: 40
summary: Studio makes videos for your projects, or on their own. An AI CLI on your computer writes the scenario from your brief, you edit it by hand or by asking AI, and every video keeps its edits and full history in a folder you choose, always outside the project's source. Nothing in the history is ever deleted, and you can go back to any earlier version.
keywords: studio, video, videos, film, movie, scenario, script, brief, ai, write with ai, ask ai, edit by typing, proposal, recipe, recipes, cli, model, effort, claude code, codex, gemini, grok, cursor, opencode, scene, scenes, narration, voice over, history, undo, redo, restore, version, versions, storage, folder, location, library, standalone, project videos, lock, another agentmate, take over, move, locate, persian, rtl
route: /studio
---

Studio is where you make videos: a launch teaser for a project, a walkthrough of a new feature, a short for social media, or a video that belongs to no project at all. A video starts as a scenario, a list of scenes with what each one shows and says, and grows from there.

## Where to find it

Click **Studio** in the menu, in the Build group. Each project also has a **Studio** tab that lists only its own videos and shows where they are kept.

## Make a video

1. Click **New video**.
2. Choose what it **belongs to** (one of your projects, or **Standalone video**), its **language** and its **format**: Landscape 16:9, Vertical 9:16, Square 1:1 or Portrait 4:5. Persian and English are written right to left and left to right automatically.
3. With **Write the scenario with AI** on, say what the video is about in your own words: who it is for, what they should feel or do, anything it must say. Pick about how long it should be, a **style** if you want one, and the **CLI**, **model** and **effort** to use. The title can stay empty; the AI names the video.
4. Click **Create and write**. The editor opens and the AI starts on the scenario.

Turn **Write the scenario with AI** off to start with an empty video and write it yourself; it then needs a title. **Start from** fills everything in from a saved recipe.

## Write the scenario with AI

Studio runs one of the AI CLIs installed on this computer (Claude Code, Codex, Gemini, Grok, Cursor or OpenCode) with the CLI, model and effort you picked. Leave the CLI empty to use your default CLI from Settings.

While it works, a card shows which AI is writing, how long it has taken and what the CLI prints, with **Cancel**. If the answer does not fit (it is not valid, or it is in the wrong language), Studio sends it back with the exact problems, up to two times. The finished scenario lands as one entry in the history, so **Undo** brings back what was there before.

Leaving the editor does not stop a run: the scenario is written into the video when it finishes. Quitting AgentMate does stop it, and the run shows as interrupted with **Try again**, since a CLI cannot pick up where it stopped.

When the video already has scenes, **Rewrite the scenario with AI** opens the same brief to write a new one.

If a run fails, the card says why in the CLI's own words, for example a CLI that needs you to sign in again or a model your plan does not include. **Details** shows everything that was sent and everything that came back.

## Edit the scenario

Each scene has a title, the narration (what the voice-over says), the lines shown **on screen** (one per line), **what the viewer sees** (written for the animation), its length in seconds and how it hands over to the next scene. Use the arrows to reorder scenes and the bin to delete one.

A field saves when you leave it, and each save becomes one entry in the history, named after what changed.

## Edit by typing

Type what you want changed in **Ask AI** above the scenario, for example "make the opening shorter" or "add a scene about pricing", and press Enter. The button beside it shows which AI makes the change; click it to pick another.

The AI answers with a proposal: every change spelled out, with the text before and after. **Apply** makes all of it as one entry in the history, so one **Undo** takes it all back. **Discard** leaves the video as it is. If you edit the scenario before applying, and the proposal no longer fits, Studio says so; ask again.

## AI runs and recipes

The History panel has two tabs. **Changes** lists every change to the video. **AI runs** lists every scenario and edit the AI was asked for, including the ones that failed or were discarded, with the CLI, model and effort used. **Details** on a run shows what you asked, the exact request sent to the CLI, its answer and its log, for the first try and each repair round.

**Save as recipe** on a scenario run keeps how that video was made: the brief, style, language, format, length and AI picks. **Recipes** on the Studio page lists them; **Use** starts a new video from one, and **Start from** in New video does the same.

## History, undo and restore

Every change is saved the moment you make it, so closing AgentMate, a crash or a power cut never loses an edit you made.

- **Undo** and **Redo** in the toolbar (or Ctrl+Z and Ctrl+Shift+Z outside a text field) step back and forward. They keep working after AgentMate restarts.
- **History** lists every change ever made to the video, newest first, with who made it (You, AI or Studio) and when.
- **Restore** on any entry takes the video back to how it was after that change. A restore is itself a new entry, so nothing after it is lost and you can undo the restore too.

Nothing is ever removed from a video's history.

## Where videos are kept

Videos are never stored inside a project's source folder, so they cannot end up in the repository or in front of an agent working on the code.

- **Standalone videos** go in the Studio library folder, by default `AgentMate Studio` in your Videos folder.
- **Project videos** go in a folder of their own for each project, by default inside the library folder. Change it in the project's **Studio** tab with **Change folder**. Studio checks the folder as you type or browse: a folder inside the project, a system folder or one AgentMate cannot write to is refused, and a folder synced by OneDrive, Dropbox, iCloud or Google Drive, a network folder or a nearly full drive gets a warning.
- Change the library folder in **Settings > Agents > Studio**.

Each video is one folder holding `studio.json` (what the video is), `studio.db` (its full history) and `document.json` (its current state). Previews and render pieces go in a working folder on this computer, never in a synced one, and are cleared oldest first past the limit you set in Settings. Your videos and their history are never cleared.

## Move, find or remove a video

Open a video card's **More** menu:

- **Open folder** shows the video's folder in your file manager.
- **Move to another folder** copies the video, checks the copy matches, switches to it, then offers to put the old copy in the trash.
- **Remove from library** takes the video off the list. Its folder stays where it is, and **Add existing folder** brings it back.

If a video's folder was moved or renamed outside AgentMate, its card says so. Click **Locate** and pick the folder.

## Open in another AgentMate

Only one copy of AgentMate can edit a video at a time, for example when the release and the development builds share a library, or two computers use a shared drive. The second one shows **Open in another AgentMate**, with which copy has it. If that copy stopped answering (it crashed, or that computer is off), **Take over** opens the video here.
