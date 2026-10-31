import type { SnippetLanguage } from '../recaptcha/snippets';
import { isTurnstileSitekey } from './turnstile';

/**
 * Ready-to-paste code for a Turnstile widget: the page side with the site key filled in, and a
 * server check against Cloudflare's `siteverify` that reads the secret from `TURNSTILE_SECRET`,
 * so the secret itself never ends up in anyone's code. The mode is set on the widget at
 * Cloudflare, so the same code serves managed, non-interactive and invisible widgets.
 */

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function html(siteKey: string): string {
  return `<script src="${SCRIPT}" async defer></script>

<form action="/submit" method="post">
  <div class="cf-turnstile" data-sitekey="${siteKey}"></div>
  <button type="submit">Send</button>
</form>`;
}

function react(siteKey: string): string {
  return `import { useEffect, useRef, useState } from 'react';

const SITE_KEY = '${siteKey}';
const SCRIPT = '${SCRIPT}?render=explicit';

export function ContactForm() {
  const box = useRef(null);
  const [token, setToken] = useState('');

  useEffect(() => {
    if (!document.querySelector(\`script[src="\${SCRIPT}"]\`)) {
      const script = document.createElement('script');
      script.src = SCRIPT;
      script.async = true;
      document.head.appendChild(script);
    }
    let widget;
    let timer;
    const draw = () => {
      if (!window.turnstile) {
        timer = setTimeout(draw, 100);
        return;
      }
      widget = window.turnstile.render(box.current, { sitekey: SITE_KEY, callback: setToken });
    };
    draw();
    return () => {
      clearTimeout(timer);
      if (widget) window.turnstile.remove(widget);
    };
  }, []);

  async function onSubmit(event) {
    event.preventDefault();
    await fetch('/api/contact', { method: 'POST', body: JSON.stringify({ token }) });
  }

  return (
    <form onSubmit={onSubmit}>
      <div ref={box} />
      <button type="submit" disabled={!token}>Send</button>
    </form>
  );
}`;
}

function php(): string {
  return `<?php
$response = file_get_contents('${VERIFY}', false, stream_context_create([
    'http' => [
        'method' => 'POST',
        'header' => 'Content-Type: application/x-www-form-urlencoded',
        'content' => http_build_query([
            'secret' => getenv('TURNSTILE_SECRET'),
            'response' => $_POST['cf-turnstile-response'] ?? '',
            'remoteip' => $_SERVER['REMOTE_ADDR'],
        ]),
    ],
]));
$result = json_decode($response, true);

if (!($result['success'] ?? false)) {
    http_response_code(400);
    exit('Please try again.');
}`;
}

function node(): string {
  return `export async function passedTurnstile(token, remoteIp) {
  const response = await fetch('${VERIFY}', {
    method: 'POST',
    body: new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET,
      response: token,
      remoteip: remoteIp,
    }),
  });
  const result = await response.json();
  return result.success === true;
}`;
}

const WRITERS: Record<SnippetLanguage, (siteKey: string) => string> = { html, react, php, node };

export function turnstileSnippetFor(language: SnippetLanguage, siteKey: string): string {
  if (!isTurnstileSitekey(siteKey)) {
    throw new Error('This does not look like a Turnstile site key.');
  }
  return WRITERS[language](siteKey);
}
