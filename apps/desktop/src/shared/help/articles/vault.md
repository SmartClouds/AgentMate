---
title: Vault
category: Connect
order: 40
summary: A password manager built into Runova that keeps logins, API keys, secure notes and custom secrets encrypted on your computer behind one master password.
keywords: vault, secrets, passwords, password manager, master password, api keys, logins, notes, totp, authenticator, 2fa, lock, unlock, import, export, csv, bitwarden, 1password, generator, clipboard
route: /vault
---

The Vault is a password manager inside Runova. It stores logins, API keys, private notes and custom entries in one encrypted file on your computer. Everything is locked with a single master password that only you know. Passwords stay hidden until you ask to see or copy them, and a copied value is wiped from the clipboard after a short time.

The Vault never sends your data anywhere. It is stored locally, and Runova cannot recover the master password for you.

## Where to find it

Click **Vault** in the sidebar under **Connect**, or open the command palette and type Vault. While the vault is unlocked, the command palette also lists your entries by title, and choosing one opens it in the Vault. When it is locked, the palette offers **Unlock Vault**. Settings for the Vault live in **Settings**, on the **Vault** tab.

## Create your vault

The first time you open the Vault, it shows "Create your vault".

1. Type a **Master password** (at least 10 characters). A strength meter shows how strong it is. Runova also refuses passwords that are too easy to guess and suggests a longer phrase of unrelated words.
2. Type it again under **Type it again**.
3. Tick the box saying you understand Runova cannot recover this password. If you forget it, the vault can only be reset, and everything in it is lost.
4. Click **Create vault**.

> [!WARNING]
> There is no "forgot password" recovery. Pick a master password you will remember, and consider writing it somewhere safe offline.

## Unlock and lock

### Unlock

When the vault is locked, the page says "Vault is locked". Type your master password and click **Unlock**.

- If the password is wrong, the box shakes and says "That password doesn't match this vault."
- After a few wrong tries in a row, Runova makes you wait a few seconds between tries ("Too many tries. Try again in Ns.").
- The lock screen tells you why it locked, if it knows: "Locked after N minutes without activity.", "Locked when this computer locked or went to sleep." or "Locked to restore a backup..." (use the master password of the vault in that backup).
- If the vault file is damaged, the message offers to reset it and start a new, empty vault.

The vault is locked each time you open Runova until you unlock it.

### Lock

The vault locks in these cases:

- You click the **Lock vault** (padlock) button in the list header, press `Ctrl+L` (`Cmd+L` on macOS), or choose **Lock Vault** in the command palette.
- It has been idle too long. The default is 15 minutes. Clicking or typing in Runova counts as activity, just moving the mouse does not.
- Your computer locks or goes to sleep (on by default).

You can change the timers in Settings (see below).

### Forgot your master password

Click **Forgot your master password?** on the lock screen. The dialog "Reset the vault?" explains that without the password nothing in the vault can be opened, by you or by Runova. Resetting sets the current vault file aside in Runova's data folder and starts an empty vault. Type `RESET` to confirm, then click **Reset vault**. A toast says the old file was set aside. You can also reset from **Settings**, **Vault**, **Reset vault**.

## The Vault page

When unlocked, the page has two panes: a list of entries on the left and the selected entry on the right. On a narrow window, only one shows at a time and a back arrow returns to the list.

If the vault is empty, the list says "Your vault is empty" with **Add your first entry** and **Import from CSV**.

### The list pane

At the top of the list:

- **Search** box. Type to find entries by title, website, username, tags and so on. Matching letters in the title are highlighted, and results are ranked by best match. Press `Ctrl+F` (`Cmd+F`) to jump to it. Use the arrow keys to move through results and `Enter` to open one. `Escape` clears the search.
- **New entry** (plus button, `Ctrl+N`).
- **More vault actions** (three dots): **Import from CSV**, **Export to CSV** and **Change master password**.
- **Lock vault** (padlock).

Search understands a few shortcuts. Type `tag:work` to show only entries with the tag "work", `type:login` (also `api`, `note`, `custom`) to filter by type, and `is:fav` for favorites.

Below the search, once you have entries:

- **Type tabs:** **All**, **Logins**, **API keys**, **Notes** and **Custom**, each with a count. Only types you actually have are shown.
- **Favorites** chip and **tag** chips. Click a chip to filter. Click again to remove the filter.
- A counter (for example "12 entries" or "3 results") and a **Sort** menu: **Title, A to Z**, **Recently used**, **Recently updated** or **Newest first**. While searching, the label says "Best match".

Favorites are pinned in a **Favorites** group above **All entries** when you are browsing.

If nothing matches, the list says what it looked for and offers **Create "your search"** (start a new entry with that title) and **Clear filters**.

Each row shows a round icon (the site's icon or a colored letter), the title, and a line underneath (username or website for logins, service and key ID for API keys, "Secure note", or the number of fields for custom entries). Hover or select a row to see quick copy buttons: **Copy username** and **Copy password** (or **Copy secret** for API keys). A star marks favorites. Press `Delete` with the list focused to delete the selected entry.

### Entry types

| Type | What it holds |
| --- | --- |
| **Login** | Username or email, password, one or more websites, an optional authenticator key (the setup secret for two-factor codes), notes. |
| **API key** | Service, Key ID, Secret, a website, an expiry date, notes. |
| **Secure note** | Free text such as recovery codes or Wi-Fi passwords. |
| **Custom** | Any number of named fields, each of which can be hidden or shown, plus notes. Good for PINs, license keys or recovery phrases. |

Every entry can also have **Tags** and can be pinned to favorites.

### The detail pane

Selecting an entry shows its details. Secrets are hidden behind dots.

- **Show** (eye icon) reveals a secret for 20 seconds, then hides it again. **Hide** hides it at once.
- **Copy** (copy icon) copies a value. A toast says what was copied and counts down to when the clipboard is cleared. It only names the field, never the value.
- Login passwords show how long ago they changed.
- API keys show their expiry date. A date in the past, or within 14 days, is flagged in yellow.
- Websites have an **Open** button that opens the site in your browser.
- Notes are hidden until you click **Show**.
- Tags are clickable and filter the list.
- A footer shows when the entry was created, updated and last used.
- Header buttons: **Add to favorites** / **Remove from favorites** (star), **Duplicate**, **Delete** (asks you to confirm, and cannot be undone) and **Edit**.

## Add or edit an entry

1. Click **New entry** (or press `Ctrl+N`). To edit, select an entry and click **Edit** (or press `Ctrl+E`).
2. When adding, choose the entry type: **Login**, **API key**, **Secure note** or **Custom**. The type can't be changed afterwards.
3. Enter a **Title**. This is the only required field.
4. Fill in the fields for that type:
   - **Login:** **Username or email**, **Password** (with a strength meter and a **Generate a password** button), **Website** (use **Add another website** for more), and **Add an authenticator key** to store a setup key or an `otpauth://` link.
   - **API key:** **Service**, **Key ID**, **Secret**, **Website**, **Expires**.
   - **Custom:** click **Add field**, give each field a **Name** and **Value**, and use the switch to hide or show it in the details. The trash button removes a field.
   - **Notes** (or **Note** for a secure note) and **Tags** (type a tag and press `Enter`, or end it with a comma).
5. Optionally turn on **Pin to favorites**.
6. Click **Save**, or press `Ctrl+Enter`.

If you close the dialog with unsaved changes, Runova asks "Discard changes?".

When you edit an entry and leave a secret unchanged, the saved secret is kept as it is.

### Site icons

When you enter a website, Runova tries to fetch the site's icon when you leave the field. **Use site icon** fetches it on demand (and tells you if none was found). **Remove site icon** goes back to the letter tile.

### Password generator

Click the dice button in the password box to open the generator.

- A password is shown right away. **Generate another** makes a new one.
- **Length** slider (the generator allows 8 to 128 characters, the slider goes up to 64).
- Switches for uppercase letters (`A-Z`), lowercase (`a-z`), digits (`0-9`) and symbols (`!#$`). At least one must stay on.
- **Avoid look-alike characters** leaves out characters that are easy to mix up.
- A strength meter for the result.
- **Use password** puts it in the entry. The generator remembers your settings.

## Import and export

### Import from CSV

Use **More vault actions**, **Import from CSV**. The dialog "Import passwords" works with exports from Chrome, Edge, Firefox, Bitwarden, 1Password and Runova. For any other CSV you pick which column is which.

1. Click **Choose CSV file** and pick the file.
2. Runova shows the file name, the detected layout (or "Unknown layout") and a preview of what will be imported. For an unknown layout, under **Match the columns**, set each column to Title, Username, Password, Website, Notes, Tags, Authenticator key, Favorite, **Add to notes** or **Don't import**.
3. If some entries already exist but differ, pick what to do: **Keep the saved entry**, **Replace the saved entry** or **Keep both**. Identical entries are skipped automatically.
4. Click **Import N entries**.
5. A summary shows how many were added, replaced, skipped and unreadable.

> [!WARNING]
> A CSV file holds your passwords in plain text. Delete it after importing.

### Export to CSV

Use **More vault actions**, **Export to CSV**. The dialog "Export the vault" asks you to:

1. Choose a format: **Runova CSV** (every field of every entry type, imports back into Runova exactly) or **Bitwarden CSV** (for moving to Bitwarden or another manager that reads its format).
2. Type your **Master password** to confirm it is you.
3. Click **Export** and choose where to save the file.

The file contains every password in plain text. Keep it somewhere safe and delete it when you are done. Do not leave it in Downloads or a synced folder.

## Settings

Go to **Settings**, then the **Vault** tab. Changes save as you click them and apply to an open vault.

| Setting | Options | Default |
| --- | --- | --- |
| **Lock after** | 1, 5, 15, 30 min, 1 hour, or Never | 15 min |
| **Clear copied values after** | 10s, 20s, 30s, 1 min, 90s, or Never | 30s |
| **Lock when this computer locks or sleeps** | On or off | On |

Clearing only happens if the clipboard still holds what the vault copied. If you copied something else in the meantime, it is left alone.

The same tab has **Change master password** (only when unlocked) and **Reset vault**.

### Change the master password

1. Unlock the vault, then open **More vault actions**, **Change master password** (or use the button in Settings).
2. Enter your **Current password**, a **New password** and the new one again.
3. Click **Change password**. A toast confirms. Use the new password the next time you unlock.

The vault is encrypted again with a fresh key. Old copies of the vault file, such as old backups, keep the old password.

## Keyboard shortcuts

These work only on the Vault page while it is unlocked. You can change them in **Settings**, **Shortcuts** (see [Keyboard shortcuts](keyboard-shortcuts.md)).

| Action | Default |
| --- | --- |
| Search the vault | `Ctrl+F` |
| New entry | `Ctrl+N` |
| Edit entry | `Ctrl+E` |
| Lock the vault | `Ctrl+L` |
| Copy password (or API key secret) | `Ctrl+Shift+C` |
| Copy username | `Ctrl+Shift+B` |

On macOS use `Cmd` instead of `Ctrl`. When a dialog is open, or when the terminal has focus, these shortcuts step aside.

## How it is stored and backed up

- The vault is one file, `vault.json`, in Runova's data folder. It is encrypted with AES-256-GCM using a key made from your master password with scrypt, a slow function that makes guessing passwords expensive. Only you can unlock it.
- It is not shared with other devices. Runova does not sync it.
- **Backups.** In **Settings**, **Data**, the backup option **Include the Vault (stays encrypted with its master password)** adds the vault file to the backup. It stays locked with its master password, so the backup needs no extra password for it. When you restore a backup that contains a Vault, Runova asks "Restore the Vault too?". Restoring replaces this computer's Vault, which is set aside in the data folder, and the vault locks. Unlock it with the master password the vault had when the backup was made. See [Backup and restore](backup-restore.md).

## Using Vault entries elsewhere

The Vault is for storing and copying secrets. Runova does not automatically hand Vault entries to your AI CLIs, terminals or SSH connections. To use one, copy it with the copy button or shortcut and paste it where you need it.

The saved passwords for SSH and Remote Desktop servers, and the secrets in project environments, are protected separately. They use your operating system keychain, plus an optional servers passkey you can set on the Remote page. See [Remote](remote.md#the-servers-passkey).

## Tips

- Use the generator for new passwords, and use tags such as "work" or "banking" to keep a big vault tidy.
- Mark the entries you use every day as favorites so they sit on top.
- Set **Clear copied values after** to a short time if you copy passwords a lot.
- Add an expiry date to API keys so the Vault warns you before they run out.

## Related

- [Remote](remote.md)
- [Backup and restore](backup-restore.md)
- [Keyboard shortcuts](keyboard-shortcuts.md)
- [Settings](settings.md)
- [Command palette and search](command-palette-search.md)
