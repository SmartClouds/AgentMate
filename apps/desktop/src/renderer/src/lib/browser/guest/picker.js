/**
 * Runova's element picker. This file is injected into pages open in a workspace browser tab
 * through webview.executeJavaScript, as a string (see browserRuntime.ts), so it must stay plain,
 * self-contained browser JavaScript: no imports, no build-time helpers, nothing from the app.
 *
 * It installs `window.__runovaPicker`. The host arms it, awaits a pick (a native promise that
 * settles on a click, a right-click or Esc), freezes the highlight while the comment card is
 * open, and draws numbered pins on the elements that have comments. Everything it draws lives in
 * a closed shadow root under one custom element, so page styles can't reach it.
 *
 * Evaluating the file returns true, which is all executeJavaScript sends back.
 */
(() => {
  const VERSION = 1;
  const existing = window.__runovaPicker;
  if (existing && existing.version === VERSION) return true;
  if (existing) existing.teardown();

  const ACCENT = '#16e07a';
  const MAX_TEXT = 200;
  const MAX_HTML = 4096;
  const MAX_SELECTOR = 700;
  const MAX_DEPTH = 8;
  const ATTRIBUTES = [
    'id',
    'class',
    'name',
    'type',
    'role',
    'href',
    'src',
    'alt',
    'title',
    'placeholder',
    'for',
    'action',
    'method',
    'aria-label',
    'data-testid',
  ];
  const STYLES = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'gap',
    'flex-direction',
    'justify-content',
    'align-items',
    'color',
    'background-color',
    'font-size',
    'font-weight',
    'line-height',
    'border-radius',
    'z-index',
  ];
  const DEFAULT_STYLES = new Set([
    '',
    'auto',
    'normal',
    'none',
    'static',
    '0px',
    'rgba(0, 0, 0, 0)',
    'transparent',
  ]);
  const SECRET = /token|secret|password|passwd|api[-_]?key|session|auth|credential|signature/i;
  const GENERATED_CLASS =
    /^(css|sc|jsx|emotion|styled|svelte|astro|tw)-|^_|__[\w-]{5,}$|[:[\]/.@!%]|\d{3,}|^[a-z]{1,3}\d/i;
  const ROLES = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    img: 'img',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    form: 'form',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    table: 'table',
    dialog: 'dialog',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
  };
  const NAMED_BY_TEXT = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'option']);

  // ---------------------------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------------------------

  const host = document.createElement('runova-picker');
  host.style.cssText =
    'all:initial;position:absolute;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .layer { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; display: none; }
      .box {
        position: fixed; display: none; pointer-events: none; border-radius: 3px;
        border: 2px solid ${ACCENT}; background: color-mix(in srgb, ${ACCENT} 12%, transparent);
        box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 0 12px color-mix(in srgb, ${ACCENT} 55%, transparent);
        transition: left 60ms ease-out, top 60ms ease-out, width 60ms ease-out, height 60ms ease-out;
      }
      .label {
        position: fixed; display: none; pointer-events: none; white-space: pre;
        font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #04140b; background: ${ACCENT}; padding: 4px 6px; border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0,0,0,.35);
      }
      .pin {
        position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px;
        display: grid; place-items: center; border-radius: 999px; pointer-events: none;
        font: 700 11px/1 system-ui, -apple-system, Segoe UI, sans-serif; color: #04140b;
        background: ${ACCENT}; border: 2px solid #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,.4);
        transition: transform 150ms ease-out;
      }
      .pin.fixed { position: fixed; }
      .pin.flash { transform: scale(1.35); box-shadow: 0 0 0 6px color-mix(in srgb, ${ACCENT} 35%, transparent), 0 2px 8px rgba(0,0,0,.4); }
    </style>
    <div class="layer"></div>
    <div class="box"></div>
    <div class="label"></div>
    <div class="pins"></div>`;
  const layer = root.querySelector('.layer');
  const box = root.querySelector('.box');
  const label = root.querySelector('.label');
  const pins = root.querySelector('.pins');
  document.documentElement.appendChild(host);

  let armed = false;
  let frozen = false;
  let current = null;
  let highlight = null;
  let pending = null;
  let frame = 0;
  let lastPoint = { x: 0, y: 0 };
  const flashTimers = new Map();
  const raf = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (fn) => setTimeout(fn, 16);

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) };
  }

  function stableClasses(el) {
    return Array.from(el.classList).filter(
      (name) => name.length > 1 && !GENERATED_CLASS.test(name),
    );
  }

  function shortName(el) {
    const tag = el.tagName.toLowerCase();
    const first = stableClasses(el)[0];
    return first ? `${tag}.${first}` : tag;
  }

  function draw(el) {
    if (!el) {
      box.style.display = 'none';
      label.style.display = 'none';
      highlight = null;
      return;
    }
    const r = rectOf(el);
    Object.assign(box.style, {
      display: 'block',
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const text = `${shortName(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    label.textContent = text;
    label.style.display = 'block';
    const above = r.y - 24;
    label.style.left = `${Math.max(4, r.x)}px`;
    label.style.top = `${above >= 4 ? above : r.y + r.height + 6}px`;
    highlight = { ...r, label: text };
  }

  function elementAt(x, y) {
    layer.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    layer.style.pointerEvents = 'auto';
    if (!el || el === host || el === document.documentElement) return null;
    return el;
  }

  // ---------------------------------------------------------------------------------------------
  // Describing the picked element
  // ---------------------------------------------------------------------------------------------

  function clip(text, max) {
    const flat = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  function escapeCss(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&');
  }

  function usableId(id) {
    return !!id && id.length < 64 && !SECRET.test(id) && !/\d{4,}|[:.]|^[a-f\d-]{8,}$/i.test(id);
  }

  function isUnique(selector, el) {
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  }

  function segmentFor(el) {
    const tag = el.tagName.toLowerCase();
    if (usableId(el.id)) return `#${escapeCss(el.id)}`;
    const classes = stableClasses(el)
      .slice(0, 2)
      .map((name) => `.${escapeCss(name)}`)
      .join('');
    return tag + classes;
  }

  function nthOfType(el) {
    const parent = el.parentElement;
    if (!parent) return '';
    const same = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
    return same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : '';
  }

  function buildSelector(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node !== document.documentElement && depth < MAX_DEPTH; depth++) {
      let segment = segmentFor(node);
      const tail = parts.length ? ` > ${parts.join(' > ')}` : '';
      if (isUnique(segment + tail, el)) return clip(segment + tail, MAX_SELECTOR);
      if (!segment.startsWith('#')) {
        segment += nthOfType(node);
        if (isUnique(segment + tail, el)) return clip(segment + tail, MAX_SELECTOR);
      }
      parts.unshift(segment);
      if (segment.startsWith('#') && isUnique(segment, node)) break;
      node = node.parentElement;
    }
    return clip(parts.join(' > '), MAX_SELECTOR);
  }

  function readablePath(el) {
    const parts = [];
    let node = el;
    while (
      node &&
      node !== document.body &&
      node !== document.documentElement &&
      parts.length < 4
    ) {
      parts.unshift(
        usableId(node.id) ? `${node.tagName.toLowerCase()}#${node.id}` : shortName(node),
      );
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return ROLES[tag] || null;
  }

  function nameOf(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, MAX_TEXT);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
      if (text.trim()) return clip(text, MAX_TEXT);
    }
    const alt = el.getAttribute('alt');
    if (alt) return clip(alt, MAX_TEXT);
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${escapeCss(el.id)}"]`);
      if (forLabel?.textContent?.trim()) return clip(forLabel.textContent, MAX_TEXT);
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return clip(placeholder, MAX_TEXT);
    const title = el.getAttribute('title');
    if (title) return clip(title, MAX_TEXT);
    if (role && NAMED_BY_TEXT.has(role)) return clip(el.textContent, MAX_TEXT) || null;
    return null;
  }

  function redactUrl(value) {
    if (!/[?&#]/.test(value)) return value;
    try {
      const url = new URL(value, location.href);
      let changed = false;
      for (const key of Array.from(url.searchParams.keys())) {
        if (SECRET.test(key)) {
          url.searchParams.set(key, 'redacted');
          changed = true;
        }
      }
      return changed ? url.href : value;
    } catch {
      return value;
    }
  }

  function redactValue(name, value) {
    if (name === 'href' || name === 'src' || name === 'action') return redactUrl(value);
    if (SECRET.test(name)) return 'redacted';
    return value;
  }

  function attributesOf(el) {
    const out = {};
    for (const name of ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value !== null && value !== '') out[name] = clip(redactValue(name, value), MAX_TEXT);
    }
    return out;
  }

  /** A copy of the element without scripts, styles and inline handlers, secrets redacted. */
  function cleanClone(el) {
    const clone = el.cloneNode(true);
    for (const node of clone.querySelectorAll('script, style, noscript, template')) node.remove();
    const all = [clone, ...clone.querySelectorAll('*')];
    for (const node of all) {
      for (const attr of Array.from(node.attributes || [])) {
        if (attr.name.startsWith('on')) node.removeAttribute(attr.name);
        else if (attr.name === 'value' && node.getAttribute('type') === 'password') {
          node.setAttribute('value', 'redacted');
        } else {
          const safe = redactValue(attr.name, attr.value);
          if (safe !== attr.value) node.setAttribute(attr.name, safe);
        }
      }
    }
    return clone;
  }

  function htmlOf(clone) {
    const html = clone.outerHTML || '';
    return html.length > MAX_HTML ? `${html.slice(0, MAX_HTML - 1)}…` : html;
  }

  function stylesOf(el) {
    const out = {};
    let computed;
    try {
      computed = getComputedStyle(el);
    } catch {
      return out;
    }
    for (const name of STYLES) {
      const value = computed.getPropertyValue(name).trim();
      if (!DEFAULT_STYLES.has(value)) out[name] = value;
    }
    return out;
  }

  function isFixed(el) {
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      try {
        if (getComputedStyle(node).position === 'fixed') return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function fiberOf(el) {
    for (let node = el, hops = 0; node && hops < 5; node = node.parentElement, hops++) {
      for (const key of Object.keys(node)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          return node[key];
        }
      }
    }
    return null;
  }

  function componentName(type) {
    if (!type || typeof type === 'string') return null;
    const name =
      type.displayName ||
      type.name ||
      type.render?.displayName ||
      type.render?.name ||
      type.type?.displayName ||
      type.type?.name;
    return typeof name === 'string' && name.length > 1 ? name : null;
  }

  function sourcePath(source) {
    if (!source?.fileName) return null;
    const file = String(source.fileName).replace(/\\/g, '/');
    const at = file.lastIndexOf('/src/');
    const short = at >= 0 ? file.slice(at + 1) : file.split('/').slice(-3).join('/');
    const line = source.lineNumber ? `:${source.lineNumber}` : '';
    const column = source.lineNumber && source.columnNumber ? `:${source.columnNumber}` : '';
    return short + line + column;
  }

  function reactOf(el) {
    let fiber;
    try {
      fiber = fiberOf(el);
    } catch {
      return null;
    }
    if (!fiber) return null;
    const components = [];
    let source = null;
    for (let node = fiber, depth = 0; node && depth < 35 && components.length < 6; depth++) {
      if (!source && node._debugSource) source = sourcePath(node._debugSource);
      const name = componentName(node.type);
      if (name && components[components.length - 1] !== name) components.push(name);
      node = node.return;
    }
    if (!components.length && !source) return null;
    return { components: components.reverse(), source };
  }

  function describe(el) {
    const role = roleOf(el);
    const viewportRect = rectOf(el);
    const clone = cleanClone(el);
    return {
      page: {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        dpr: window.devicePixelRatio || 1,
      },
      element: {
        tagName: el.tagName.toLowerCase(),
        selector: buildSelector(el),
        path: readablePath(el),
        role,
        name: nameOf(el, role),
        text: clip(clone.textContent, MAX_TEXT),
        html: htmlOf(clone),
        attributes: attributesOf(el),
        styles: stylesOf(el),
        react: reactOf(el),
        rectViewport: viewportRect,
        rectPage: {
          ...viewportRect,
          x: round(viewportRect.x + window.scrollX),
          y: round(viewportRect.y + window.scrollY),
        },
        fixed: isFixed(el),
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------------------------

  function settle(result) {
    const resolve = pending;
    pending = null;
    if (resolve) resolve(result);
  }

  function track(x, y) {
    if (!armed || frozen) return;
    lastPoint = { x, y };
    if (frame) return;
    frame = raf(() => {
      frame = 0;
      if (!armed || frozen) return;
      current = elementAt(lastPoint.x, lastPoint.y);
      draw(current);
    });
  }

  function onPointerMove(event) {
    track(event.clientX, event.clientY);
  }

  function pickAt(event, kind) {
    if (!armed || frozen) return;
    event.preventDefault();
    event.stopPropagation();
    const el = elementAt(event.clientX, event.clientY) || current;
    if (!el) return;
    current = el;
    draw(el);
    settle({ kind, payload: describe(el) });
  }

  function onClick(event) {
    if (event.button === 0 || event.button === undefined) pickAt(event, 'pick');
  }

  function onContextMenu(event) {
    event.preventDefault();
    pickAt(event, 'copy');
  }

  function swallow(event) {
    if (!armed) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onWheel(event) {
    if (frozen) event.preventDefault();
  }

  function onKeyDown(event) {
    if (!armed || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    settle({ kind: 'cancel' });
  }

  function onScroll() {
    if (frozen && current) draw(current);
    else track(lastPoint.x, lastPoint.y);
  }

  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('click', onClick);
  host.addEventListener('contextmenu', onContextMenu);
  host.addEventListener('mousedown', swallow);
  host.addEventListener('pointerdown', swallow);
  host.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);

  // ---------------------------------------------------------------------------------------------
  // Pins
  // ---------------------------------------------------------------------------------------------

  let markers = [];

  function renderMarkers() {
    pins.textContent = '';
    for (const marker of markers) {
      const pin = document.createElement('div');
      pin.className = `pin${marker.fixed ? ' fixed' : ''}${flashTimers.has(marker.id) ? ' flash' : ''}`;
      const rect = marker.fixed ? marker.rectViewport : marker.rectPage;
      pin.style.left = `${rect.x}px`;
      pin.style.top = `${rect.y}px`;
      pin.textContent = String(marker.n);
      pin.dataset.id = marker.id;
      pins.appendChild(pin);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------------------------

  window.__runovaPicker = {
    version: VERSION,
    arm() {
      armed = true;
      frozen = false;
      layer.style.display = 'block';
      host.style.pointerEvents = 'none';
    },
    disarm() {
      armed = false;
      frozen = false;
      current = null;
      layer.style.display = 'none';
      draw(null);
      settle({ kind: 'cancel' });
    },
    async awaitPick() {
      settle({ kind: 'cancel' });
      return await new Promise((resolve) => {
        pending = resolve;
      });
    },
    cancel() {
      settle({ kind: 'cancel' });
    },
    freeze() {
      frozen = true;
    },
    setMarkers(next) {
      markers = Array.isArray(next) ? next : [];
      renderMarkers();
    },
    flashMarker(id) {
      clearTimeout(flashTimers.get(id));
      flashTimers.set(
        id,
        setTimeout(() => {
          flashTimers.delete(id);
          renderMarkers();
        }, 1200),
      );
      renderMarkers();
    },
    reveal(id) {
      const marker = markers.find((one) => one.id === id);
      if (!marker) return false;
      if (!marker.fixed) {
        const top = marker.rectPage.y - window.innerHeight / 3;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
      window.__runovaPicker.flashMarker(id);
      return true;
    },
    /**
     * Hides everything the picker draws, for a screenshot. Hiding settles after two frames, so
     * the page has repainted without the highlight by the time the host captures it.
     */
    setChromeHidden(hidden) {
      host.style.visibility = hidden ? 'hidden' : '';
      if (!hidden) return true;
      return new Promise((resolve) => raf(() => raf(() => resolve(true))));
    },
    inspect() {
      return {
        armed,
        frozen,
        highlight,
        chromeHidden: host.style.visibility === 'hidden',
        markers: markers.map((marker) => {
          const rect = marker.fixed ? marker.rectViewport : marker.rectPage;
          return {
            id: marker.id,
            n: marker.n,
            left: rect.x,
            top: rect.y,
            fixed: !!marker.fixed,
            flashing: flashTimers.has(marker.id),
          };
        }),
      };
    },
    teardown() {
      settle({ kind: 'cancel' });
      for (const timer of flashTimers.values()) clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      host.remove();
      delete window.__runovaPicker;
    },
  };
  return true;
})();
