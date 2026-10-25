#!/usr/bin/env node
// A stand-in for Claude Code in the Studio scenario e2e (e2e/studioScenario.e2e.ts). Studio sends
// the whole request on stdin, so this reads it and answers by what kind of request it is:
//   - a scenario request answers with a Persian scenario, except that a brief containing BROKEN
//     first gets JSON cut off half-way, so the repair round has something to fix;
//   - a repair request answers with the good scenario;
//   - an edit request renames the first scene it finds in the request;
//   - a scene request answers with a small scene page showing the scene's title, except that a
//     change asking for NETWORK gets a scene that tries to fetch, so its check fails and the fix
//     round (which gets the good scene) has something to repair.
// A request containing SLOW takes six seconds, so a test can see the run while it works.
// It prints progress to stderr the way the real CLI does, and its arguments go to the launch log
// through the shim in e2e/app.ts.
'use strict';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

const SCENARIO = {
  title: 'آب، زندگی',
  logline: 'یک ویدیوی کوتاه درباره‌ی صرفه‌جویی در آب.',
  audience: 'خانواده‌ها',
  tone: 'گرم و امیدوار',
  scenes: [
    {
      title: 'قطره',
      narration: 'هر قطره‌ی آب ارزش دارد.',
      onScreenText: ['هر قطره مهم است'],
      durationSeconds: 6,
      visualBrief: 'A single drop falls in slow motion onto a calm surface.',
    },
    {
      title: 'شیر آب',
      narration: 'یک شیر چکه‌کن در سال هزاران لیتر آب هدر می‌دهد.',
      onScreenText: ['۳۰۰۰ لیتر در سال'],
      durationSeconds: 8,
      transition: 'fade',
    },
    {
      title: 'پایان',
      narration: 'از امروز شروع کنیم.',
      durationSeconds: 5,
    },
  ],
};

let request = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  request += chunk;
});
process.stdin.on('end', () => {
  process.stderr.write('Reading the request\n');
  setTimeout(
    () => {
      process.stderr.write('Writing the answer\n');
      process.stdout.write(answer());
      process.exit(0);
    },
    request.includes('SLOW') ? 6000 : 400,
  );
});

function scenePage(title, extra) {
  return [
    '```html file:index.html',
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:#123456}',
    '#t{position:absolute;left:0;right:0;top:40%;text-align:center;color:#fff;font:700 120px Vazirmatn,sans-serif}',
    '</style></head><body>',
    `<div id="t" lang="fa" dir="rtl">${title}</div>`,
    '<script src="scene.js"></script></body></html>',
    '```',
    '```js file:scene.js',
    `${extra}Studio.scene({ render(t, ctx) { document.getElementById('t').style.opacity = String(0.3 + 0.7 * ctx.progress); } });`,
    '```',
  ].join('\n');
}

function answer() {
  if (request.includes('# Fix the scene')) {
    const title = /Scene \d+ of \d+: (.+)/.exec(request)?.[1] ?? 'صحنه';
    return scenePage(title, '');
  }
  if (request.includes('# Animate a scene') || request.includes('# Change a scene')) {
    const title = /Scene \d+ of \d+: (.+)/.exec(request)?.[1] ?? 'صحنه';
    const network = request.includes('NETWORK');
    return scenePage(
      network ? `${title} +` : title,
      network ? "fetch('https://example.com/data');\n" : '',
    );
  }
  if (request.includes('# Fix your previous answer')) return JSON.stringify(SCENARIO);
  if (request.includes('# Write a video scenario')) {
    if (request.includes('BROKEN')) return '{"logline": "cut off", "scenes": [{"title": "a"';
    return `Here is the scenario:\n\`\`\`json\n${JSON.stringify(SCENARIO)}\n\`\`\``;
  }
  if (request.includes('# Change a video scenario')) {
    const sceneId = /"id":\s*"([A-Za-z0-9_-]+)"/.exec(request)?.[1] ?? 'missing';
    return JSON.stringify({
      summary: 'Renamed the first scene.',
      ops: [{ op: 'scene.update', sceneId, patch: { title: 'آغاز' } }],
    });
  }
  return 'I do not know what to do with this request.';
}
