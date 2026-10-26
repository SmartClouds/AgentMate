/**
 * The workspace browser's pages run in their own session, apart from the app's default one:
 * the app rewrites the Content-Security-Policy of everything loaded in the default session, which
 * would break real sites, and a page's cookies and storage have no business next to the app's.
 */
export const BROWSER_PARTITION = 'persist:runova-browser';

/**
 * Keys pressed while a page has focus never reach the app's renderer, so main catches these few
 * and hands them over. Everything else stays with the page.
 */
export type GuestShortcut =
  | 'pick'
  | 'focusAddress'
  | 'reload'
  | 'hardReload'
  | 'back'
  | 'forward'
  | 'devtools';
