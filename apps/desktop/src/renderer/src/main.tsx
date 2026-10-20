import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Imported as JS modules, not CSS @import in index.css, because Vite/Tailwind v4's
// CSS-import asset resolution doesn't rebase these packages' internal woff2
// url()s, so the font files silently fail to end up in the build output.
import '@fontsource-variable/inter';
import '@fontsource-variable/vazirmatn';
import './index.css';
import { applyWindowGlass, trackWindowFocus } from './lib/windowGlass';
import { applyInitialTheme } from './stores/themeStore';

// Before React renders, so the first frame already lets the native material show through.
applyWindowGlass(document.documentElement, window.location.search);
// Same for the theme: waiting on the settings call left a light page on a dark window. A window
// opened on a route (the SFTP pop-out) carries it in the hash instead.
applyInitialTheme(window.location.search, window.location.hash);
trackWindowFocus(document.documentElement, window.agentmat?.window);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
