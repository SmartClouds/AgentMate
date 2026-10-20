---
title: Deploy servers and setup
category: Deploy
order: 20
summary: Add a server, check it, install the AgentMate server core, sign in, turn on two-factor, and manage who and which computers can reach the core.
keywords: add server, ssh, sudo password, preflight, install, server core, setup, enroll, enrollment code, sign in, two-factor, 2fa, totp, recovery codes, users, roles, devices, sessions, uninstall, remove core, update core
---

Before Deploy can do anything on a server, two things have to be in place: the server is saved in Remote with its SSH login, and the AgentMate server core is installed on it. The core is a small service that runs on the server and listens only on a private socket, so no port is opened. AgentMate reaches it through your SSH login.

This article walks through adding a server, the preflight check, the install, your account on the core, and what you can manage afterward (users, computers and sessions).

## Where to find it

Click **Deploy** in the sidebar under Ship. Servers themselves are added in **Remote**. Pick a server in the **Servers** list on the left. For a server without a core, the main area shows **Install the server core**. After that, **Your access** is at the bottom of the server's **Overview**, and users, devices and sessions are under the **Security** section.

## Add a server

Deploy does not have its own "add server" form. It uses the servers you save in [Remote](remote.md).

1. Click **Add or edit servers in Remote** under the server list (or open **Remote** in the sidebar).
2. Click **Add server** and fill in **Nickname**, **Host**, **Port** (22 by default) and **Username**.
3. Choose how to sign in: **Password**, or **Private key** (a **Private key file** and, only if the key is protected, a **Key passphrase**).
4. Save, then go back to **Deploy**. A new server does not show up in the list by itself: click **Choose servers to show**, tick it and click **Save**. It appears in the list with "Core not installed".

If the server's host key has changed since you last connected, AgentMate stops and asks whether to trust the new key. Only an explicit "trust" stores it. If you are sure it is your server (for example after you reinstalled it), trust it. Otherwise cancel, because a changed key can also mean someone is in the middle of the connection.

> [!NOTE]
> If your saved servers are protected with a passkey and locked, unlock them first with the **Unlock** button in the yellow banner at the top of Deploy.

## Preflight checklist

Opening a server without a core runs a read-only check over SSH. Nothing is changed on the server. The result is a checklist, each row marked ready, a note, or "blocks the install":

| Row | What it checks |
| --- | --- |
| **Operating system** | Supported: Ubuntu 22.04, 24.04 or 26.04, Debian 12 or 13, and RHEL, Rocky, Alma or CentOS Stream 9 or 10. |
| **Processor** | x64 or arm64. |
| **Service manager** | The server must run systemd. |
| **Free space** | At least 300 MB free under `/opt` and `/var`. |
| **Root access** | How the install gets root: signed in as root, sudo with no password, sudo with the saved login password, sudo that asks for a password, or no sudo at all (blocks the install). |
| **Connection** | Only shown when the server's SSH does not allow tunnels. The core's own bridge over SSH is used instead. |
| **SELinux** | Shown when SELinux is enforcing or permissive. The files get labelled for it. |
| **Installed now** | Shown when a core is already there, with its version. |

If anything blocks the install, a red box titled "This server cannot take the core yet" lists the reasons and the install button is disabled. Fix the problem on the server and click **Check again**.

While the check runs, a line under the placeholders says which server is being checked. On a slow connection it changes to say the server is slow to answer. The check stops by itself if the server stops answering. If it fails (for example the server cannot be reached, or it accepts the login but does not answer a command, which usually means it is overloaded or the connection is failing), you see the reason and a **Check again** button. It does not retry by itself.

## Install the server core

With a clean checklist, set up the install and press the button.

1. **Account on the core.** For a brand new core you create its first account, the Owner. Under **Your account on the core** enter a **User name** and a **Password** (at least 12 characters), and confirm the password. The user name can use letters, digits, dots, dashes, underscores and `@`. The password cannot contain the user name, and the core refuses very common passwords. The password is set up on the server over SSH and never saved in AgentMate.
2. **Sudo password.** If the server needs a sudo password and the saved login has none, a **Sudo password for (user)** field appears. It is used for this step only and never saved. If the saved login password is used you can click **Use a different password**.
3. Click the install button. Its label depends on the server: **Install core (version)**, **Update to core (version)** or **Reinstall core (version)**.
4. Watch the **Install steps** timeline (see below). You can leave the page: the install keeps going and shows up again when you come back.

When it finishes, a message says the core is running on the server and the rail entry turns **Online**. If your account could not be set up, a warning tells you to finish from the server card.

### Setup timeline

The timeline lists the whole plan before it runs, then marks each step as waiting, in progress, done or failed. A progress bar shows for steps like uploading. The steps are:

1. **Check the server**
2. **Get the server core** (downloads the release for your AgentMate version)
3. **Upload it to the server**
4. **Verify the checksum on the server**
5. **Give your login access to the core** (adds your SSH user to the `agentmate` group)
6. **Unpack the release**
7. **Label the files for SELinux** (only on SELinux servers)
8. **Install the system service**
9. **Switch to the new release**
10. **Start the core**
11. **Tidy up old files**
12. **Check that it answers**
13. **Set up your account on the core**, **Enroll this computer** and **Sign in** (when you gave an account)

If a new core does not start, the timeline adds **Go back to the previous release** and the server returns to the core it had before.

### When setup fails

A red box explains why the install stopped, with a fold-out **What the core logged** showing the core's last log lines. Below it you can:

- Fix the account fields or enter the sudo password, if the message asks for it ("The server did not accept that password" or "This server needs the sudo password to go on").
- Click **Try again** to run it again.
- Click **Check the server again** to go back to the checklist.

### Update or reinstall the core

On an installed server, open the menu (three dots) on the **Server core** card on the Overview and choose **Update or reinstall**. The panel says the running core keeps working until the new one is ready, and that if the new one does not start the server goes back to the one it has now. Choose **Update to core (version)** or **Reinstall core (version)**, or **Cancel** to go back. The security checklist in the **Security** section can also offer an update of the core when one is due. The DevHost cannot be updated this way.

## Server core health

The **Server core** card on the Overview shows a live look at the core:

- A badge: **Online**, **Not answering** or **Connecting…**, and how it answers ("Answering through the SSH tunnel, checked 20 s ago", or the core's bridge over SSH, loopback to the DevHost, or the core's own TLS port).
- **Version**, **Up for**, **Installed**, **Operating system**, **Processor** and **Connection** (SSH tunnel, Core bridge over SSH, Loopback (DevHost) or Direct TLS).
- **Check now** (the refresh button) to ask again right away.
- A **More actions** menu with **Update or reinstall**, **Remove the core, keep its data** and **Remove the core and its data**.

If the core is not answering you see the error. If the server just restarted, the core starts with it and answers again shortly.

## Remove the core

From the **More actions** menu on the **Server core** card:

- **Remove the core, keep its data**: the service and program go. The data folder and settings stay, so a later install picks up where this one left off.
- **Remove the core and its data**: everything of the core goes. Deleted data cannot be brought back.

A confirmation dialog explains the choice. A **Removing the server core** panel then shows steps (**Stop the core** and **Remove its files**). If it fails you can enter the sudo password if asked, click **Try again**, or **Dismiss**. When done, the server is back to "Core not installed". Removing the core does not delete the server from Remote.

## Your access

The **Your access** card (on the Overview, and on the Security section when you are signed out) shows how this computer signs in to the core: its own key, your password, and optionally a code from an authenticator app. The card shows the step you need next.

| State | What you see | Button |
| --- | --- | --- |
| Signed in | "Signed in as (name)" with your roles, and whether two-factor is on | **Turn on two-factor** or **Turn off two-factor**, and **Sign out** |
| Needs a password | "Sign in to manage this core." | **Sign in** |
| Not enrolled yet | "This computer is not enrolled on this core yet." | **Enroll this computer**, **Use an enrollment code** |
| Revoked or removed | "The core no longer accepts this computer…" | **Enroll again**, **Use an enrollment code** |
| Cannot be reached | The reason | **Try again** |

### Sign in to the core

Click **Sign in** on the card. The dialog **Sign in to (server)** asks for your **Password** on the core (this computer proves itself with its own key). If two-factor is on, a second step asks for the **Authenticator code**, the 6-digit code from your app. If you lost your phone click **Lost your phone? Use a recovery code** and enter one of your saved codes, or **Use the authenticator app instead** to go back.

Common messages: "That password is not right", "That code is not right, or it was used already. Codes change every 30 seconds", "Too many attempts. Wait a minute and try again", and "The core no longer accepts this computer. Close this and enroll it again."

In development builds, the DevHost shows its sign-in on the dialog: user `dev` with the password `agentmate-local-password`.

### Enroll this computer

Enrolling gives this computer its own key on the core. Use it when you have SSH access with root or sudo.

1. Click **Enroll this computer** (or **Enroll again**).
2. In **Enroll this computer on (server)**, enter the **User name** and **Password** of an account the core already has.
3. If the server asks for it, a **Sudo password** field appears. Enter it.
4. Click **Enroll**. AgentMate makes a new key for this computer and registers it on the core over SSH, then signs in.

You can also do this during the install by filling in the account fields, or leave them empty on an existing core and do it later from the server card.

### Redeem an enrollment code

When you do not have sudo on the server, an Owner of the core can give you an enrollment code. Your SSH login still has to be in the server's `agentmate` group.

1. Click **Use an enrollment code** on the card, or **Join with a code** on the install panel ("The core already runs here. With an enrollment code from one of its Owners, this computer can join it without sudo").
2. In **Join (server) with a code** enter the **Enrollment code**, your **User name** and your **Password** on the core.
3. Click **Join**.

The code works once and expires. If it is wrong, used or expired you see "That code is wrong, used or expired. Ask an Owner for a new one." If your account uses two-factor, you finish with a code from your authenticator app. No password is saved in AgentMate. See [Enrollment codes](#enrollment-codes) to make one.

### Two-factor sign-in

Turn on two-factor so a stolen password alone cannot get into the core.

1. On the **Your access** card click **Turn on two-factor**.
2. First confirm your **Password**, then click **Continue**.
3. Scan the QR code with an authenticator app (1Password, Google Authenticator, Authy and others). With no camera, type the shown key into the app instead, or click **Copy the key**.
4. Enter the **Code from the app** and click **Turn on**.
5. Save the **Recovery codes** that appear. Each one works once if you lose your phone and they are not shown again. Click **Copy all**, then **I saved them**.

To turn it off click **Turn off two-factor**, confirm your password and enter a current code, then click **Turn off**.

### Sign out

**Sign out** ends your session on the core. The computer stays enrolled. The next time you open the server you sign in again with your password.

## Users, devices and sessions

These live in the **Security** section of a server (see [Firewall and security](deploy-firewall-security.md) for the rest of that section). You see only the tabs your role allows.

### Roles

Each core user has one role, and each role includes everything below it.

| Role | What it may do |
| --- | --- |
| **Owner** | Everything, including users and the security of the server. |
| **Admin** | Runs the server: commands, websites, firewall, certificates and the audit trail. |
| **Operator** | Deploys and runs apps, updates packages and restarts services. |
| **Viewer** | Sees everything and changes nothing. |

### Users (Owners)

The **Users** tab lists who can sign in to the core. Each row shows the name, a **You** marker for yourself, the role, whether two-factor is on, when the user last signed in and how many devices they have, plus a status: **Active**, **Disabled**, or **Locked until (time)** after too many wrong passwords (it unlocks by itself or when an Owner unlocks it).

- **Add a user** opens a dialog with **User name**, **Role** (Operator by default), **Password** and **Confirm the password**. After adding, a message offers **Make a code** so their computer can join.
- The actions menu on each row has the **Role** options (Owner, Admin, Operator, Viewer), **Enrollment code**, and for other users **Reset the password**, **Unlock** (when locked), **Disable** or **Enable**, and **Remove**.
- Changing a role closes that user's open connections so they come back with the new role. The core never lets you leave it without an Owner.
- **Disable** signs the user out everywhere. Their devices stay enrolled.
- **Reset the password** ends all their sessions. Give them the new password in person or another safe way.
- **Remove** deletes the account with its devices, sessions and enrollment codes. You type the user's name to confirm. The audit trail keeps what they did.

Every change here asks you to confirm your password again, valid for 10 minutes (**Changing who can reach (server) takes your password again**).

### Enrollment codes

An Owner makes a code for a user from the **Enrollment code** item (for yourself it reads "Enrollment code for another computer of yours").

1. In the dialog choose **Valid for**: 15 minutes, 1 hour, 8 hours or 24 hours.
2. Click **Make the code**.
3. Click **Copy the code**. This is the only time it is shown. It works once, until the time shown.
4. On the other computer: save the server in Remote with an SSH login that is in the server's `agentmate` group, open Deploy, pick the server and choose **Join with a code**.

Anyone holding the code and that user's password can enroll a computer until it is used or runs out, so share it carefully.

### Devices

The **Devices** card lists the computers enrolled on the core. Everyone sees their own computers. Admins and Owners see every computer, with the owner's name. Each row shows its name, **This computer** if it is the one you are on, when it was enrolled, when it was last seen, and its status (**Active** or **Revoked**). **Revoke** signs that computer out and it cannot sign in again until it enrolls again (over SSH or with an enrollment code). Revoking the computer you are on warns you that it has to enroll again before it can manage the server.

### Your sessions

The **Your sessions** card lists each time you signed in on any of your computers: **This session** marker, when it started, last activity and when it ends. A session lasts up to 180 days, or 30 without use. **End the session** on a row signs that computer out. **End all other sessions** signs out every computer of yours except this one. They ask for your password the next time they are used.

## Tips

- Use a unique, long password for your core account. Password managers work well here.
- Turn on two-factor and save the recovery codes before you need them.
- If you are locked out of the core, an Owner can reset your password, or use **Restore a backup over SSH** from the Security section (see [Firewall and security](deploy-firewall-security.md)).
- You can ask the **Ask the guide** chat in [Help center](help-center.md) about any of these steps.

## Related

- [Deploy](deploy.md)
- [Deploy: firewall and security](deploy-firewall-security.md)
- [Remote](remote.md)
- [Vault](vault.md)
- [Troubleshooting](troubleshooting.md)
