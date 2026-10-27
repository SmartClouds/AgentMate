import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, Notification, nativeImage } from 'electron';
import { appIcon } from '../appIcon';
import { focusMainWindow } from '../mainWindow';

/**
 * OS notifications that take the user to what they are about when clicked.
 *
 * A plain `notification.on('click')` is not enough on Windows. The listener lives on the JS
 * object, so once that object is garbage collected, or the toast has timed out into the Action
 * Center, a click reaches nothing. Windows toasts therefore carry their route in the toast's
 * `launch` argument, and `Notification.handleActivation` reads it back no matter what happened
 * to the object (even when the click is what started the app).
 */

const ROUTE_ARG = 'runova-route';
/** Names the notification in a toast's launch args, so its onClick can be found again. */
const ID_ARG = 'runova-notification';
/** Enough to keep recent toasts clickable without holding on to every one ever shown. */
const MAX_LIVE = 50;
/** The instance event and the activation callback both fire for one click on Windows. */
const DUPLICATE_CLICK_MS = 1500;

const live = new Map<string, Notification>();
/**
 * Click actions by notification id. Kept apart from `live` so an Action Center click still finds
 * its action once the toast object is gone, and removed on first use so one click runs it once.
 */
const clickActions = new Map<string, () => void>();
let lastOpened = { route: '', at: 0 };
let toastIconUrl: string | null | undefined;

export interface OsNotificationInput {
  title: string;
  body: string;
  /** The renderer route a click opens, e.g. `/workspace/<projectId>?session=<tabId>`. */
  route: string;
  silent?: boolean;
  /**
   * Runs on click instead of opening `route`, for things that live outside the main window
   * (a Remote Desktop session window, for one).
   */
  onClick?: () => void;
}

/** Runs and forgets a notification's click action. Does nothing once it has already run. */
function runClickAction(id: string): void {
  const action = clickActions.get(id);
  if (!action) return;
  clickActions.delete(id);
  action();
}

function openRoute(route: string): void {
  const now = Date.now();
  if (lastOpened.route === route && now - lastOpened.at < DUPLICATE_CLICK_MS) return;
  lastOpened = { route, at: now };
  focusMainWindow(route);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Toasts can't show an .ico, so the app icon is written out once as a PNG. */
function iconForToast(): string | null {
  if (toastIconUrl !== undefined) return toastIconUrl;
  try {
    const png = nativeImage.createFromPath(appIcon).toPNG();
    const path = join(app.getPath('temp'), 'runova-notification-icon.png');
    writeFileSync(path, png);
    toastIconUrl = png.length > 0 ? pathToFileURL(path).href : null;
  } catch {
    toastIconUrl = null;
  }
  return toastIconUrl;
}

function toastXml(
  id: string,
  { title, body, route, silent, onClick }: OsNotificationInput,
): string {
  const launch = new URLSearchParams(
    onClick ? { [ROUTE_ARG]: route, [ID_ARG]: id } : { [ROUTE_ARG]: route },
  ).toString();
  const iconUrl = iconForToast();
  return [
    `<toast launch="${escapeXml(launch)}" activationType="foreground">`,
    '<visual><binding template="ToastGeneric">',
    `<text>${escapeXml(title)}</text>`,
    body ? `<text>${escapeXml(body)}</text>` : '',
    iconUrl ? `<image placement="appLogoOverride" src="${escapeXml(iconUrl)}"/>` : '',
    '</binding></visual>',
    silent ? '<audio silent="true"/>' : '',
    '</toast>',
  ].join('');
}

function forget(id: string): void {
  live.delete(id);
}

/**
 * Shows an OS notification that opens `route` when clicked. Returns false when the platform
 * has no notifications, so the caller can fall back to something in the app.
 */
export function showOsNotification(input: OsNotificationInput): boolean {
  if (!Notification.isSupported()) return false;
  const id = randomUUID();
  const notification =
    process.platform === 'win32'
      ? new Notification({ id, toastXml: toastXml(id, input) })
      : new Notification({
          id,
          title: input.title,
          body: input.body,
          icon: appIcon,
          silent: input.silent ?? false,
        });

  if (input.onClick) {
    clickActions.set(id, input.onClick);
    if (clickActions.size > MAX_LIVE) {
      const oldest = clickActions.keys().next().value;
      if (oldest) clickActions.delete(oldest);
    }
  }

  notification.on('click', () => {
    forget(id);
    if (input.onClick) runClickAction(id);
    else openRoute(input.route);
  });
  notification.on('close', (details) => {
    // A toast that timed out moves to the Action Center and can still be clicked there.
    if (details?.reason !== 'timedOut') forget(id);
  });
  notification.on('failed', () => forget(id));

  // Held here so the object, and its click listener, outlive this call.
  live.set(id, notification);
  if (live.size > MAX_LIVE) {
    const oldest = live.keys().next().value;
    if (oldest) forget(oldest);
  }

  notification.show();
  return true;
}

/**
 * Routes Windows toast clicks, including ones from the Action Center after the notification
 * object is gone and ones that launched the app. Call once the main window exists, since a
 * click that started the app is replayed as soon as this registers.
 */
export function registerNotificationActivation(): void {
  if (process.platform !== 'win32') return;
  Notification.handleActivation((details) => {
    if (details.type !== 'click') return;
    const args = new URLSearchParams(details.arguments);
    const id = args.get(ID_ARG);
    // A toast with an onClick never opens a route. The action may already have run from the
    // instance event, in which case this does nothing.
    if (id) {
      runClickAction(id);
      return;
    }
    const route = args.get(ROUTE_ARG);
    if (route?.startsWith('/')) openRoute(route);
    else focusMainWindow();
  });
}
