/** Ping defaults and limits, shared by the main-process probe and the Settings page. */

export const DEFAULT_PING_URL = 'https://www.gstatic.com/generate_204';
/** Cloudflare and Google public DNS, the same resolvers on both IP families. */
export const DEFAULT_PING_TARGETS_IPV4 = ['1.1.1.1'];
export const DEFAULT_PING_TARGETS_IPV6 = ['2606:4700:4700::1111', '2001:4860:4860::8888'];
export const MAX_PING_URLS = 5;
export const DEFAULT_PING_URL_INTERVAL_SECONDS = 5;
export const MIN_PING_URL_INTERVAL_SECONDS = 1;
export const MAX_PING_URL_INTERVAL_SECONDS = 300;
