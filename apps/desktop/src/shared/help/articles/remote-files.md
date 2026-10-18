---
title: Remote files
category: Connect
order: 30
summary: Browse another computer running AgentMate, and upload, download, rename, delete and create folders on it, without opening a control session.
keywords: remote files, file manager, file transfer, upload, download, browse files, files only, transfer, folders, rename, delete, resume, hash, verified
route: /remote-files
---

The Remote files page is a file manager for another computer that runs AgentMate. After you connect to it, you can browse its drives and folders, create folders, rename and delete items, upload a file from your computer into any folder, and download a file from it. Transfers are split into parts, checked with a hash, and resume if the connection drops.

This page works over the same connection as AgentMate's remote control (see [Remote](remote.md)). It is for another AgentMate on your network. It is not an SFTP client for SSH servers. To upload a site to an SSH, SFTP or FTP server, use [FTP and SFTP sites](deploy-ftp-sftp.md) in Deploy.

## Where to find it

You do not open this page from the sidebar. It opens when you connect for files from the Remote page:

1. Click **Remote** in the sidebar under **Connect**, and open the **Connect** tab.
2. On the other computer, open **Remote**, **Host**, start hosting and generate a pairing code.
3. Either paste the code and click **Connect (files only)**, or, for a computer you have connected to before, click **Browse files** on its row under **Saved servers**.

AgentMate then opens Remote files. If you are already connected with files only, the Connect tab has an **Open file manager** button.

If you open `/remote-files` without a connection, the page says "Not connected. Go to Remote, Connect and use "Browse files" on a saved server, or connect with a pairing code first."

> [!NOTE]
> A files-only connection does not stream the other computer's screen and does not let you control it. If you connect with the normal **Connect** button instead, you get the remote control window and can still use this page with the same connection.

## Browse

The title card shows the folder you are in. At the top level it says **This computer**, and lists the roots of the other machine (its drives or home folder).

- Click a folder's name to open it.
- Click the back arrow to go up one folder. From a drive or top folder it goes back to the list of roots.
- Click the **Refresh** button to reload the current folder.
- Files show their size. Folders and files have different icons.
- An empty folder says "This folder is empty."
- If a folder cannot be opened, a red message appears and a toast says "Could not open that folder".

The page header says "Browsing (device name)".

## Work with files and folders

Each row has buttons on the right.

| Button | What it does |
| --- | --- |
| **Download** (files only) | Asks the other computer to send you that file. It is saved in your Downloads folder. If a file with that name is already there, a number is added, like `report (1).pdf`. |
| **Rename** | Turns the name into a text box. Press `Enter` (or click away) to save, `Escape` to cancel. |
| **Delete** | Asks you to confirm, then deletes the file, or the folder and everything inside it, on the other computer. |

When you are inside a folder (not at the top level), the title card also has:

- **New folder.** Click it, type a **Folder name** and press `Enter` (or click away) to create it. `Escape` cancels.
- **Upload.** Opens a file picker on your computer. The file you choose is sent into the folder you are viewing.

At the top level, Upload and New folder are hidden. If you try to upload without a folder open, a toast says "Open a folder before uploading into it."

> [!WARNING]
> Deleting is permanent and happens on the other computer. The other computer does not ask first.

## Transfers

While files move, a **Transfers** card appears below the list. Each transfer shows an arrow for the direction (down for incoming, up for outgoing), the name, and progress such as "12 MB / 80 MB".

- Large files are sent in parts of 10 MB. The card shows "completed/total parts".
- If the connection drops, the row shows "Reconnecting..." and the transfer resumes where it left off.
- When a transfer finishes, it shows **Verified** when the file arrived intact (its checksum matches), or "Hash mismatch" if not.
- A red bar and message mean the transfer failed.

The **Remote** page shows the same transfers in its **File transfers** card.

## Security

Anyone who can pair with the host can browse its whole filesystem, because the connection already gives them control of the machine. Only share a pairing code with people you trust. Codes work once and expire after 5 minutes.

## Tips

- To send a single file quickly without browsing, use **Send file** on the Host or remote window instead.
- Folders cannot be downloaded or uploaded as a whole. Transfer files one at a time.
- For files on an SSH server, use a terminal tab and your usual tools (`scp`, `rsync`).

## Related

- [Remote](remote.md)
- [Remote Desktop](remote-desktop.md)
- [Troubleshooting](troubleshooting.md)
