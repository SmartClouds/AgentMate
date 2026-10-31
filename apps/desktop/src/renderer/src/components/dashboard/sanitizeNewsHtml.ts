import DOMPurify from 'dompurify';

/**
 * A news item's body, cleaned again before the renderer shows it. The API sanitizes on its side
 * too, but this window can reach the preload bridge, so markup from the network is never trusted
 * on that word alone. Scripts, event handlers and `javascript:` links go (DOMPurify's defaults),
 * and so do inline styles and form controls, which an article never needs and which could dress
 * up part of the body as the app's own UI.
 */
export function sanitizeNewsHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
  });
}

/** Only web links leave the app; anything else in a body link is ignored. */
export function isWebUrl(href: string | null | undefined): href is string {
  if (!href) return false;
  try {
    const { protocol } = new URL(href);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
