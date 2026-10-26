# Runova Mobile

A React Native (Expo) controller app for Runova's Remote feature. It connects
directly to a Runova desktop instance that is hosting (Remote → Host tab)
over your local network, using the same WebSocket protocol the
desktop app uses to control itself. It's defined once in
[`@runova/protocol`](../../packages/protocol) and shared by both apps.

## Running it

From the repo root:

```sh
pnpm mobile
```

This builds `@runova/protocol` and starts the Expo dev server. Scan the
printed QR code with **Expo Go** (iOS/Android) to run the app on your phone,
no Xcode/Android Studio setup required. Your phone and the computer running
Runova must be on the same Wi-Fi network.

Alternatively, from this directory: `pnpm start` (or `pnpm android` / `pnpm ios`
if you have the native toolchains installed).

## Using it

1. On the desktop, open **Remote → Host**, start hosting, and generate a
   pairing code.
2. On the phone, tap **Scan QR** and point the camera at the desktop's QR
   code, or paste the `RUNOVA1:…` code by hand.
3. Once connected, the host's screen streams in as tiles you can tap/drag to
   click and move the cursor, two-finger drag to scroll, and long-press for a
   right click. The bottom bar opens the system keyboard for typing and has
   Esc/Tab/Enter/Backspace/arrow keys the soft keyboard can't send. The
   "Clipboard" button pushes your phone's clipboard to the host; clipboard
   text sent from the host is copied to the phone automatically.

## What's not implemented yet

File transfer (the desktop's "Send file" in the Connect tab) isn't
implemented on mobile, so chunks for an incoming file are silently ignored.
Hosting from the phone (letting a desktop control the phone) is also out of
scope; this app is controller-only.

## Code layout

- `src/remote/useRemoteClient.ts`: the WebSocket state machine (hello/auth,
  screen-info, binary tile frames, input, clipboard). Mirrors the controller
  role in `apps/desktop/src/main/remote/manager.ts`, but the socket is opened
  directly here since there's no separate main/renderer process to protect.
- `src/components/TileCanvas.tsx`: renders incoming JPEG tiles as an
  absolutely-positioned mosaic (no `<canvas>` in React Native) and turns
  touch gestures into the same normalized `RemoteInputEvent`s the desktop's
  `RemoteScreen.tsx` sends from mouse events.
- `src/components/Toolbar.tsx`: soft-keyboard capture + special keys.
- `src/screens/ConnectScreen.tsx` / `src/screens/RemoteScreen.tsx`: the two
  screens; `App.tsx` switches between them based on connection status.
