---
title: Android
category: Ship
order: 40
summary: Run Android emulators, create and edit virtual devices, and work with connected phones (screenshots, screen recording, APK install, adb shell).
keywords: android, emulator, avd, virtual device, adb, sdk, apk, phone, usb debugging, wireless debugging, screenshot, screen recording, system image, avdmanager, sdkmanager, platform-tools
route: /android
---

The Android page is a control panel for the Android SDK on your computer. It lists your virtual devices (emulators) and any phones or tablets plugged in, lets you start and stop emulators, create and edit them, and take screenshots, record the screen, rotate the device, open an `adb shell` or install an APK on a running device.

It uses the Android SDK you already have, for example the one installed by Android Studio, and finds it for you.

## Where to find it

Click **Android** in the sidebar under **Ship**, or open the command palette and type Android. The status bar at the bottom also has an Android entry (see below). To change which SDK folder Runova uses, go to **Settings**, the **General** tab, and the **Android SDK** card.

## If the SDK is not found

When Runova cannot find an Android SDK, the page shows "Android SDK not found". It checks the `ANDROID_HOME` and `ANDROID_SDK_ROOT` environment variables and the usual install folders for your operating system. A list titled **Where Runova looked** shows every path it tried, with a green check next to the one it used and a gray cross next to the ones that did not work.

An SDK folder has at least one of `platform-tools`, `emulator` or `cmdline-tools` in it. Android Studio installs one for you.

You have these buttons:

- **Choose SDK folder.** Pick your SDK folder yourself.
- **Clear override.** Only shown when a folder you picked earlier is not a valid SDK ("That folder isn't an Android SDK"). It goes back to automatic detection.
- **Check again.** Looks again after you installed something.
- **How to install.** Opens the Android Studio download page.

### Partial SDK banner

If the SDK is found but is missing the `emulator`, `avdmanager` or `sdkmanager` pieces, a yellow banner says what is missing. Connected phones keep working. Virtual devices need the missing packages. The banner shows the `sdkmanager` command that installs them, and **Copy command** puts it on your clipboard.

## The device list

At the top, tiles show **Running** (emulators that are up), **Virtual devices** and **Connected** (physical devices). A badge shows the platform-tools (adb) version, and hovering it shows the SDK folder. **Refresh** reloads the list.

Below that:

- **Search devices** filters by device name, id or serial.
- **View tabs:** **All**, **Running**, **Virtual** and **Physical**.
- **Pair over Wi-Fi** opens the wireless pairing dialog.
- **New device** opens the create dialog.

If nothing is listed, the page says "No devices yet": virtual devices you create and phones you plug in with USB debugging turned on show up here. A filter with no results says 'No devices match "your text".' or "Nothing in this view."

### Emulator cards

Each virtual device is a card with its name, API level, CPU architecture (ABI) and RAM, and a status badge: **Running**, **Starting**, **Stopped** or **Failed**.

- **Start** boots the emulator. While it boots, the card shows a progress bar and the current stage (Launching emulator, Waiting for device, Booting Android, Finishing up), and the button becomes **Cancel**.
- **Stop** shuts a running emulator down.
- A running emulator shows live **CPU** and **Memory** meters. The CPU meter says "measuring" for the first second or two because it needs two samples.
- If the emulator failed to start, the reason is shown in red on the card.
- The serial (like `emulator-5554`) appears under the name once it is running. Click it to copy it.

Running emulators also get a row of icon buttons (see "Actions on a running device" below) and a **More actions** (three dots) menu.

### More actions menu

| Item | What it does |
| --- | --- |
| **Edit** | Opens the Edit dialog for the virtual device. |
| **Cold boot** | Starts the device from scratch, ignoring any saved snapshot. Disabled while it runs. |
| **Wipe data** | Erases everything on the device, including installed apps and accounts. The device itself stays. Asks you to confirm. Disabled while it runs. |
| **Delete** | Deletes the virtual device and everything on it. This cannot be undone. Asks you to confirm. Disabled while it runs. |

### Physical device cards

Phones and tablets connected by USB or Wi-Fi get a card with the model name, serial, Android version, API level and the connection type (USB or Wi-Fi). The badge says **Physical** when the phone is ready.

- **Unauthorized.** The phone has not trusted this computer yet. Look at the phone for the "Allow USB debugging" prompt and tick "Always allow from this computer". No buttons are shown until then.
- **Offline.** The device is attached but not responding. Unplug it and plug it back in.

## Actions on a running device

A running emulator or a ready phone has these icon buttons on its card:

| Button | What it does |
| --- | --- |
| **Screenshot** | Takes a screenshot and saves it as a PNG. A toast "Screenshot saved" offers to reveal the file. |
| **Record screen** / **Stop recording** | Records the screen to an MP4. Recording stops on its own after three minutes (an Android limit). Only one recording can run at a time. A toast "Recording saved" offers to reveal the file. |
| **Rotate** | Turns the screen a quarter turn. |
| **Open shell** | Opens a terminal tab named `adb shell` for that device with the adb command already typed. |
| **Install APK** | Opens a file picker so you can choose one or more `.apk` files to install. |

Screenshots and recordings are saved in a `Runova/Android` folder inside your Pictures and Videos folders.

### Drag and drop an APK

You can also drop `.apk` files anywhere on the device list.

- With exactly one device ready, the drop installs straight onto it.
- With several, drop the file on the card of the device you want.
- If no device is ready, you see "Start an emulator or plug in a phone first."
- Files that are not `.apk` are refused with "Only .apk files can be installed on a device."

While you drag, an overlay says "Install on (device name)" or "Drop the APK on a device".

## Create a virtual device

1. Click **New device**.
2. In **Name**, type a name such as "Pixel 7 API 34". Spaces are fine. If the saved id differs from what you typed (for example `Pixel_7_API_34`), a line "Saved as ..." shows it. Names must be unique.
3. Pick a **Device** profile (the hardware to emulate). It defaults to `pixel_7` when available.
4. Pick a **System image** (the Android version to run). The newest installed one is selected by default. You can search by API level, ABI or words like "playstore".
5. Click **Create**.

If the SDK has no `avdmanager`, the dialog explains that creating a device needs the Android SDK Command-line Tools. In Android Studio, open Settings, Languages and Frameworks, Android SDK, the SDK Tools tab, and tick "Android SDK Command-line Tools". **How to install** opens the download page.

### Download a system image

When no system images are installed, the **System image** area offers to download one.

1. Pick an image from **Image to download** (they are a few hundred megabytes each).
2. Tick **I accept the Android SDK licence terms**. **Read** opens the terms.
3. Click **Download and install**. A progress bar shows the download.

If Runova cannot get the list of images, it shows the SDK's own error and a **Try again** button.

## Edit a virtual device

Choose **Edit** from the **More actions** menu.

- **Name.** Only the display name changes. Its id stays the same.
- **RAM (MB)** (at least 512), **Internal storage (MB)** (at least 512) and **Graphics** (Automatic, Hardware (host GPU), Software, Off).
- **System image.** Shown for information only. To run a different Android version, delete the device and create a new one.
- **Show advanced settings** expands more groups:
  - **Emulated performance:** **Multi-core CPU (cores)** (1 to 16) and **Always cold boot**.
  - **Memory and storage:** **VM heap (MB)** and **SD card (MB)** (0 means no card).
  - **Camera:** **Front** (None, Emulated, Webcam) and **Back** (None, Emulated, Webcam, VirtualScene).
  - **Network:** **Speed** (Full, HSDPA, UMTS, EDGE, GPRS, HSCSD, GSM) and **Latency** (None, UMTS, EDGE, GPRS).
  - **Device:** **Hardware keyboard** and **Show the device frame**.
- Click **Save**. It is only enabled when something changed.

If the device is running, the dialog warns that changes take effect the next time it starts.

## Connect a phone

### With a USB cable

1. On the phone, turn on Developer options and USB debugging.
2. Plug it in. It appears as a **Physical** card.
3. If the card says **Unauthorized**, accept the prompt on the phone.

### Over Wi-Fi

1. Click **Pair over Wi-Fi**.
2. On the phone, go to Settings, Developer options, Wireless debugging, then "Pair device with pairing code".
3. Enter the **Address and port** the phone shows (for example `192.168.1.20:37105`) and the six digit **Pairing code**, then click **Pair**.
4. In the next step, **Connect**, the address is filled in with port 5555. Check it against the address at the top of the phone's Wireless debugging screen (it can differ), then click **Connect**.

Errors appear under the fields so you can read them while holding the phone.

> [!NOTE]
> The pairing port and the connect port are different. The pairing port is a one-time port the phone shows only on the pairing screen.

## Status bar entry

When an SDK is found, the status bar shows an Android icon with the number of running emulators (and a small pulse while one is booting). Click it to see up to eight running or booting emulators with their memory and CPU use. Click one to jump to its card on the Android page, which flashes a ring for a few seconds.

## Settings: Android SDK

In **Settings**, **General** tab, the **Android SDK** card has:

- The SDK folder that is in use, where it came from (set here, `ANDROID_HOME`, `ANDROID_SDK_ROOT` or the usual install folder) and the platform-tools version.
- **Browse** to pick a different SDK folder, and **Clear** (shown only when you set a folder) to go back to automatic detection.
- **Stop emulators when Runova quits.** Off by default, because an emulator is a window you can close yourself and takes a while to boot again.

## Tips

- Emulators that nothing has used for a while show up on the Dashboard's **Idle Docker and Emulators** card, which can stop them for you. It only looks while an adb server is already running, so it never starts one, and its clock starts when Runova first sees an emulator. See [Dashboard](dashboard.md#idle-docker-and-emulators).
- An agent can use the same `adb` from the [Workspace](workspace-terminals-agents.md) terminal. **Open shell** is a quick way to get one.
- If emulators will not start, check the Partial SDK banner first. A missing `emulator` package is the usual cause.

## Related

- [Settings](settings.md)
- [Workspace terminals and agents](workspace-terminals-agents.md)
- [Interface tour](interface-tour.md)
- [Troubleshooting](troubleshooting.md)
