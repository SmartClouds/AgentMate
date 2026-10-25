/**
 * The Content-Security-Policy of the app's own pages, set on every response of the default
 * session. Vite's dev server needs an inline HMR/preamble script and a websocket back to itself;
 * the packaged app never talks to either, so production stays locked down to 'self'.
 *
 * - Blueprint attachments are served from the app's own scheme, so it is named in img-src and
 *   media-src; media-src would otherwise fall back to default-src and refuse an attached video.
 * - Remote Desktop runs Devolutions' IronRDP as WebAssembly: compiling it needs
 *   'wasm-unsafe-eval', the module ships inline so it is fetched from a data: URL, and the session
 *   reaches its server through the loopback-only proxy in main/rdp/proxy.ts.
 * - Studio previews scenes in iframes from `studio-scene:` (E33). Those pages carry their own,
 *   much stricter policy, which `keepsOwnCsp` leaves in place.
 */

export interface AppCspOptions {
  isDev: boolean;
  blueprintScheme: string;
  studioSceneScheme: string;
}

export function appCsp({ isDev, blueprintScheme, studioSceneScheme }: AppCspOptions): string {
  const files = `${blueprintScheme}:`;
  const scenes = `${studioSceneScheme}:`;
  const rdp = { script: "'wasm-unsafe-eval'", connect: 'data: ws://127.0.0.1:*' };
  return isDev
    ? `default-src 'self' http://localhost:5173 ws://localhost:5173; script-src 'self' 'unsafe-inline' ${rdp.script} http://localhost:5173; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${files}; media-src 'self' ${files}; font-src 'self' data:; connect-src 'self' ${rdp.connect} http://localhost:5173 ws://localhost:5173; worker-src 'self' blob:; frame-src 'self' http://localhost:5173 ${scenes};`
    : `default-src 'self'; script-src 'self' ${rdp.script}; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${files}; media-src 'self' ${files}; font-src 'self' data:; connect-src 'self' ${rdp.connect}; worker-src 'self' blob:; frame-src 'self' ${scenes};`;
}

/**
 * A Studio scene page keeps the policy it was served with. The app's policy would loosen it: it
 * allows the loopback websocket and the dev server, and scene code must reach no network at all.
 */
export function keepsOwnCsp(url: string, studioSceneScheme: string): boolean {
  return url.startsWith(`${studioSceneScheme}:`);
}
