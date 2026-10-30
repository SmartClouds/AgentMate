import type { RecaptchaKeyType } from '../deployRecaptchaTypes';

/**
 * Ready-to-paste code for a new key: the front end with the site key filled in, and a back end
 * check against Google's `siteverify` that reads the secret from `RECAPTCHA_SECRET`, so the secret
 * itself never ends up in anyone's code.
 */

export type SnippetLanguage = 'html' | 'react' | 'php' | 'node';

export const SNIPPET_LANGUAGES: readonly { id: SnippetLanguage; label: string }[] = [
  { id: 'html', label: 'HTML' },
  { id: 'react', label: 'React' },
  { id: 'php', label: 'PHP check' },
  { id: 'node', label: 'Node.js check' },
];

export interface SnippetKey {
  siteKey: string;
  type: RecaptchaKeyType;
}

const SITE_KEY = /^[A-Za-z0-9_-]{1,100}$/;
const SCRIPT = 'https://www.google.com/recaptcha/api.js';
const VERIFY = 'https://www.google.com/recaptcha/api/siteverify';

function html({ siteKey, type }: SnippetKey): string {
  if (type === 'score') {
    return `<script src="${SCRIPT}?render=${siteKey}"></script>

<form id="form" action="/submit" method="post">
  <input type="hidden" name="g-recaptcha-response" id="g-recaptcha-response">
  <button type="submit">Send</button>
</form>

<script>
  document.getElementById('form').addEventListener('submit', (event) => {
    event.preventDefault();
    grecaptcha.ready(() => {
      grecaptcha.execute('${siteKey}', { action: 'submit' }).then((token) => {
        document.getElementById('g-recaptcha-response').value = token;
        event.target.submit();
      });
    });
  });
</script>`;
  }
  if (type === 'checkbox') {
    return `<script src="${SCRIPT}" async defer></script>

<form action="/submit" method="post">
  <div class="g-recaptcha" data-sitekey="${siteKey}"></div>
  <button type="submit">Send</button>
</form>`;
  }
  return `<script src="${SCRIPT}" async defer></script>

<form id="form" action="/submit" method="post">
  <button class="g-recaptcha" data-sitekey="${siteKey}" data-callback="onSubmit">Send</button>
</form>

<script>
  function onSubmit() {
    document.getElementById('form').submit();
  }
</script>`;
}

function react({ siteKey, type }: SnippetKey): string {
  const load = `const SITE_KEY = '${siteKey}';

function useRecaptchaScript(src) {
  useEffect(() => {
    if (document.querySelector(\`script[src="\${src}"]\`)) return;
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    document.head.appendChild(script);
  }, [src]);
}`;
  if (type === 'score') {
    return `import { useEffect } from 'react';

${load}

export function ContactForm() {
  useRecaptchaScript(\`${SCRIPT}?render=\${SITE_KEY}\`);

  async function onSubmit(event) {
    event.preventDefault();
    await new Promise((resolve) => window.grecaptcha.ready(resolve));
    const token = await window.grecaptcha.execute(SITE_KEY, { action: 'submit' });
    await fetch('/api/contact', { method: 'POST', body: JSON.stringify({ token }) });
  }

  return <form onSubmit={onSubmit}><button type="submit">Send</button></form>;
}`;
  }
  const size = type === 'invisible' ? ", size: 'invisible'" : '';
  const submit =
    type === 'invisible'
      ? `async function onSubmit(event) {
    event.preventDefault();
    window.grecaptcha.execute(widget.current);
  }`
      : `async function onSubmit(event) {
    event.preventDefault();
    const token = window.grecaptcha.getResponse(widget.current);
    await fetch('/api/contact', { method: 'POST', body: JSON.stringify({ token }) });
  }`;
  return `import { useEffect, useRef } from 'react';

${load}

export function ContactForm() {
  const box = useRef(null);
  const widget = useRef(null);
  useRecaptchaScript('${SCRIPT}?render=explicit');

  useEffect(() => {
    const draw = () => {
      if (!window.grecaptcha?.render) return setTimeout(draw, 100);
      widget.current = window.grecaptcha.render(box.current, {
        sitekey: SITE_KEY${size},
        callback: (token) => fetch('/api/contact', { method: 'POST', body: JSON.stringify({ token }) }),
      });
    };
    draw();
  }, []);

  ${submit}

  return (
    <form onSubmit={onSubmit}>
      <div ref={box} />
      <button type="submit">Send</button>
    </form>
  );
}`;
}

function php({ type }: SnippetKey): string {
  const check =
    type === 'score'
      ? `$passed = ($result['success'] ?? false)
    && ($result['action'] ?? '') === 'submit'
    && ($result['score'] ?? 0) >= 0.5;`
      : `$passed = $result['success'] ?? false;`;
  return `<?php
$response = file_get_contents('${VERIFY}', false, stream_context_create([
    'http' => [
        'method' => 'POST',
        'header' => 'Content-Type: application/x-www-form-urlencoded',
        'content' => http_build_query([
            'secret' => getenv('RECAPTCHA_SECRET'),
            'response' => $_POST['g-recaptcha-response'] ?? '',
            'remoteip' => $_SERVER['REMOTE_ADDR'],
        ]),
    ],
]));
$result = json_decode($response, true);
${check}

if (!$passed) {
    http_response_code(400);
    exit('Please try again.');
}`;
}

function node({ type }: SnippetKey): string {
  const check =
    type === 'score'
      ? `return result.success && result.action === 'submit' && result.score >= 0.5;`
      : `return result.success === true;`;
  return `export async function passedRecaptcha(token, remoteIp) {
  const response = await fetch('${VERIFY}', {
    method: 'POST',
    body: new URLSearchParams({
      secret: process.env.RECAPTCHA_SECRET,
      response: token,
      remoteip: remoteIp,
    }),
  });
  const result = await response.json();
  ${check}
}`;
}

const WRITERS: Record<SnippetLanguage, (key: SnippetKey) => string> = { html, react, php, node };

export function snippetFor(language: SnippetLanguage, key: SnippetKey): string {
  if (!SITE_KEY.test(key.siteKey)) throw new Error('This does not look like a reCAPTCHA site key.');
  return WRITERS[language](key);
}
