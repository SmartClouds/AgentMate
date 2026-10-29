import splashLogoDark from '@/assets/splash-logo.webp';
import splashLogoLight from '@/assets/splash-logo-light.webp';
import unboundedFont from '@/assets/unbounded-latin-variable.woff2';
import { readSplashParams } from './splashParams';

// Everything the splash needs comes in on the URL from src/main/splashWindow.ts,
// so it renders without waiting on any IPC round trip.
const view = readSplashParams(window.location.search, new Date().getFullYear());
const root = document.documentElement;
root.dataset.theme = view.theme;
root.dataset.glass = view.glass;

// The light variant draws the white strokes in near-black, since white would vanish on light glass.
const logo = document.getElementById('logo') as HTMLImageElement;
logo.src = view.theme === 'dark' ? splashLogoDark : splashLogoLight;

// Unbounded is only used for the wordmark. It ships with the app so the splash never needs the network.
const wordmark = new FontFace('Unbounded', `url(${unboundedFont}) format('woff2')`, {
  weight: '200 900',
});
document.fonts.add(wordmark);

const credit = document.getElementById('credit');
if (credit) credit.textContent = view.credit;

const status = document.getElementById('status');
window.runova.splash.onStatus((text) => {
  if (status) status.textContent = text;
});
window.runova.splash.onClose(() => {
  document.body.classList.add('closing');
});

// Fade in once the logo and the wordmark font are ready, so the card never shows up
// without the logo or flashes the name in the fallback font first.
void Promise.all([logo.decode(), wordmark.load()])
  .catch(() => undefined)
  .then(() => requestAnimationFrame(() => document.body.classList.add('ready')));
