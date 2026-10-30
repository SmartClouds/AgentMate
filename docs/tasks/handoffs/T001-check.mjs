// T001 doc checks. Usage: node check-t001.mjs <repoRoot> [--worktree <path>]

import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const wtIdx = process.argv.indexOf('--worktree');
const worktree = wtIdx > 0 ? resolve(process.argv[wtIdx + 1]) : null;

const SPECS = [
  'docs/epics/40-website.md',
  'docs/epics/41-website-api.md',
  'docs/epics/42-dashboard-news.md',
  'docs/website/api-contract.md',
  'docs/website/design.md',
];
const failures = [];
const fail = (m) => failures.push(m);
const read = (p) => readFileSync(join(root, p), 'utf8');

// 1. Spec files exist (main checkout and worktree)
for (const s of SPECS) {
  if (!existsSync(join(root, s))) fail(`missing ${s}`);
  if (worktree && !existsSync(join(worktree, s))) fail(`missing in worktree ${s}`);
}

// 2. Every spec path named by a task resolves
const taskDir = join(root, 'docs/tasks');
for (const f of readdirSync(taskDir).filter((n) => /^T\d+.*\.md$/.test(n))) {
  const fm = readFileSync(join(taskDir, f), 'utf8').split('---')[1] ?? '';
  for (const m of fm.matchAll(/^\s+-\s+(\S+\.md)\s*$/gm)) {
    if (!existsSync(join(root, m[1]))) fail(`${f}: spec ${m[1]} does not resolve`);
  }
}

const docs = SPECS.filter((s) => existsSync(join(root, s))).map((s) => [s, read(s)]);

// Strip fenced blocks tagged `forbidden` (the list itself) before phrase scans
const withoutForbiddenBlocks = (t) => t.replace(/```forbidden[\s\S]*?```/g, '');

// 3. No em dash anywhere in the new docs
for (const [s, t] of docs) if (t.includes('—')) fail(`${s}: em dash`);
for (const extra of ['docs/DELIVERY_STATUS.md', 'docs/tasks/handoffs/T001.md']) {
  if (existsSync(join(root, extra)) && read(extra).includes('—')) fail(`${extra}: em dash`);
}

// 4. No mention of a mobile version of Runova outside the forbidden list block
const mobile = [
  /runova mobile/i,
  /mobile app/i,
  /companion app/i,
  /iphone/i,
  /\bios\b/i,
  /\bipad\b/i,
  /testflight/i,
  /google play/i,
  /play store/i,
  /\bapk\b/i,
  /pair (your|a) phone/i,
  /react native/i,
  /\bexpo\b/i,
];
for (const [s, t] of docs) {
  const body = withoutForbiddenBlocks(t);
  for (const re of mobile) if (re.test(body)) fail(`${s}: mobile phrase ${re}`);
}

// 5. Relative links resolve
for (const [s, t] of docs) {
  for (const m of t.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
    const href = m[1];
    if (/^[a-z]+:/i.test(href)) continue;
    if (!existsSync(resolve(join(root, dirname(s)), href))) fail(`${s}: broken link ${href}`);
  }
}

// 6. HMAC vectors reproduce
const contract = docs.find(([s]) => s.endsWith('api-contract.md'))?.[1] ?? '';
const vectors = contract.split(/^#### Vector /m).slice(1);
if (vectors.length < 1) fail('api-contract.md: no HMAC vector');
for (const v of vectors) {
  const name = v.split('\n')[0];
  const get = (label) => v.match(new RegExp(`^- ${label}: \`([^\`]*)\``, 'm'))?.[1];
  const secret = get('Secret');
  const key = get('Signing key \\(hex\\)');
  const sig = get('Signature header');
  const body = get('Body') ?? '';
  const bodyHash = get('Body SHA-256');
  const canon = v.match(/Canonical string:\n\n```text\n([\s\S]*?)\n```/)?.[1];
  if (!secret || !key || !sig || !bodyHash || canon === undefined) {
    fail(`vector ${name}: missing field`);
    continue;
  }
  const k = createHash('sha256').update(secret, 'utf8').digest('hex');
  if (k !== key) fail(`vector ${name}: signing key ${k} != ${key}`);
  const bh = createHash('sha256').update(body, 'utf8').digest('hex');
  if (bh !== bodyHash) fail(`vector ${name}: body hash ${bh} != ${bodyHash}`);
  if (!canon.endsWith(bodyHash))
    fail(`vector ${name}: canonical string does not end in the body hash`);
  const s = createHmac('sha256', Buffer.from(key, 'hex')).update(canon, 'utf8').digest('hex');
  if (`v1=${s}` !== sig) fail(`vector ${name}: signature v1=${s} != ${sig}`);
}

// 7. Endpoint tables: method, path, auth, request, responses; plural nouns under /api/v1
const SINGLETONS = new Set([
  'me',
  'current',
  'latest',
  'two-factor',
  'downloads',
  'recovery-codes',
  'password',
  'v1',
  'api',
  'media',
]);
let endpointCount = 0;
for (const line of contract.split('\n')) {
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(cells[0] ?? '')) continue;
  endpointCount++;
  if (cells.length < 5 || cells.slice(0, 5).some((c) => c === ''))
    fail(`endpoint row incomplete: ${line}`);
  const path = cells[1].replace(/`/g, '').split('?')[0];
  if (!path.startsWith('/api/v1/')) fail(`endpoint not under /api/v1: ${path}`);
  for (const seg of path.split('/').filter(Boolean)) {
    if (seg.startsWith('{') || SINGLETONS.has(seg)) continue;
    if (!/s$/.test(seg)) fail(`endpoint segment not a plural noun: ${seg} in ${path}`);
  }
  if (!/\b[1-5]\d\d\b/.test(cells[4] ?? '')) fail(`endpoint without status codes: ${path}`);
}
if (endpointCount < 30) fail(`api-contract.md lists only ${endpointCount} endpoints`);

// 8. Design tokens match index.css for Dark and Light
const css = readFileSync(join(root, 'apps/desktop/src/renderer/src/index.css'), 'utf8');
const block = (sel) => css.match(new RegExp(`^${sel} \\{([\\s\\S]*?)\\n\\}`, 'm'))?.[1] ?? '';
const tokens = (b) =>
  Object.fromEntries([...b.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const light = tokens(block(':root,\\n\\.theme-light'));
const dark = tokens(block('\\.dark'));
const design = docs.find(([s]) => s.endsWith('design.md'))?.[1] ?? '';
for (const t of [
  'primary',
  'background',
  'card',
  'border',
  'muted',
  'destructive',
  'warning',
  'success',
]) {
  if (!dark[t] || !light[t]) fail(`index.css token ${t} not parsed`);
  const row = `| \`--${t}\` | \`${dark[t]}\` | \`${light[t]}\` |`;
  if (!design.includes(row)) fail(`design.md lacks row ${row}`);
}

// 9. DELIVERY_STATUS rows
const status = read('docs/DELIVERY_STATUS.md');
for (const id of ['E40W', 'E41', 'E42']) {
  if (!new RegExp(`^\\| ${id} \\|`, 'm').test(status)) fail(`DELIVERY_STATUS.md lacks row ${id}`);
}

// 10. Worktree
if (worktree) {
  const list = execFileSync('git', ['-C', root, 'worktree', 'list'], { encoding: 'utf8' });
  if (!list.split('\n').some((l) => l.includes('Runova-website') && l.includes('[website]'))) {
    fail('git worktree list has no Runova-website on [website]');
  }
}

if (failures.length) {
  console.log(`FAIL (${failures.length})\n` + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`PASS: ${endpointCount} endpoints, ${vectors.length} HMAC vectors`);
