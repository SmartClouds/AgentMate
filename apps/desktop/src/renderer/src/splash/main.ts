import appIconDark from '@/assets/app-icon.png';
import appIconLight from '@/assets/app-icon-light.png';
import { readSplashParams } from './splashParams';

// Everything the splash needs comes in on the URL from src/main/splashWindow.ts,
// so it renders without waiting on any IPC round trip.
const view = readSplashParams(window.location.search, new Date().getFullYear());
const root = document.documentElement;
root.dataset.theme = view.theme;
root.dataset.glass = view.glass;

const logo = document.getElementById('logo') as HTMLImageElement;
logo.src = view.theme === 'dark' ? appIconDark : appIconLight;

const credit = document.getElementById('credit');
if (credit) credit.textContent = view.credit;

const status = document.getElementById('status');
window.runova.splash.onStatus((text) => {
  if (status) status.textContent = text;
});
window.runova.splash.onClose(() => {
  document.body.classList.add('closing');
});

// Fade in once the logo can paint with the rest, so the card never shows up without it.
void logo
  .decode()
  .catch(() => undefined)
  .then(() => requestAnimationFrame(() => document.body.classList.add('ready')));
