---
title: Studio
category: Build
order: 40
summary: Studio makes videos for your projects, or on their own. Each video keeps its scenario, its edits and its full history in a folder you choose, always outside the project's source. Every change is saved as you make it, nothing in the history is ever deleted, and you can go back to any earlier version.
keywords: studio, video, videos, film, movie, scenario, script, scene, scenes, narration, voice over, history, undo, redo, restore, version, versions, storage, folder, location, library, standalone, project videos, lock, another agentmate, take over, move, locate, persian, rtl
route: /studio
---

Studio is where you make videos: a launch teaser for a project, a walkthrough of a new feature, a short for social media, or a video that belongs to no project at all. A video starts as a scenario, a list of scenes with what each one shows and says, and grows from there.

## Where to find it

Click **Studio** in the menu, in the Build group. Each project also has a **Studio** tab that lists only its own videos and shows where they are kept.

## Make a video

1. Click **New video**.
2. Give it a title and choose what it **belongs to**: one of your projects, or **Standalone video** for one with no project.
3. Pick its **language** and **format**: Landscape 16:9, Vertical 9:16, Square 1:1 or Portrait 4:5. Persian and English are written right to left and left to right automatically.
4. Click **Create video**. The dialog shows the folder it will be saved in.

## Write the scenario

The editor opens on the scenario. Write what the video is about in a sentence or two, then add scenes. Each scene has a title, the narration (what the voice-over says) and a length in seconds. Use the arrows to reorder scenes and the bin to delete one.

A field saves when you leave it, and each save becomes one entry in the history, named after what changed.

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
