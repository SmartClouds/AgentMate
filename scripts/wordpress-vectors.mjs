#!/usr/bin/env node
/**
 * Writes packages/core/src/deploy/wordpress/vectors/protocol-v1.json, the test vectors the
 * desktop (TypeScript) and the AgentMate Connector plugin (PHP) both run, so the two sides agree
 * byte for byte on canonical strings, signatures, keys, path rules and frames.
 *
 * Expected answers for the rule-based cases (paths, slugs, keys) are written out here by hand and
 * checked against the built core before anything is written: a mismatch stops the script, so a
 * bug in core can never quietly become "the expected answer".
 *
 * Run after `pnpm build:packages`:  node scripts/wordpress-vectors.mjs
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(new URL('../packages/core/dist/index.js', import.meta.url).href);

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const seedFrom = (label) => createHash('sha256').update(`agentmate-wp vectors: ${label}`).digest();

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
function ed25519(seed) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = b64url(
    Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url'),
  );
  return {
    publicKey,
    sign: (message) => b64url(sign(null, Buffer.from(message, 'utf8'), privateKey)),
  };
}

function check(condition, message) {
  if (!condition) {
    console.error(`wordpress-vectors: ${message}`);
    process.exit(1);
  }
}

const siteSeed = seedFrom('site');
const desktopSeed = seedFrom('desktop');
const site = ed25519(siteSeed);
const desktop = ed25519(desktopSeed);
const nonceA = b64url(Buffer.from([...Array(16).keys()]));
const nonceB = b64url(Buffer.from([...Array(16).keys()].map((n) => 255 - n)));
const connectionId = '6f1c2a9e-3b7d-4c51-9e0a-2d8f4b6c1a03';
const pairingId = '0b8e5d2c-7a14-4f3e-b6c9-91d2e3f4a5b6';
const pairingSecret = b64url(seedFrom('pairing secret'));
const emptySha = sha256Hex(Buffer.alloc(0));
const now = 1_790_000_000;

// Ed25519 itself, so a PHP sodium (or sodium_compat) build is checked before anything else.
const ed25519Vectors = [
  { label: 'site', seedHex: hex(siteSeed), message: 'agentmate', key: site },
  { label: 'desktop', seedHex: hex(desktopSeed), message: '', key: desktop },
].map(({ label, seedHex, message, key }) => ({
  label,
  seedHex,
  publicKey: key.publicKey,
  message,
  signature: key.sign(message),
}));

const requestInputs = [
  {
    route: '/site/info',
    timestamp: now,
    nonce: nonceA,
    connectionId,
    bodySha256: emptySha,
  },
  {
    route: '/pair',
    timestamp: now + 1,
    nonce: nonceB,
    connectionId: null,
    bodySha256: sha256Hex(Buffer.from('bundle')),
  },
];
const canonicalRequest = requestInputs.map((input) => {
  const text = core.wpCanonicalRequest(input);
  return { input, text, signer: 'desktop', signature: desktop.sign(text) };
});

const responseInputs = [
  {
    route: '/site/info',
    requestNonce: nonceA,
    connectionId,
    timestamp: now + 2,
    httpStatus: 200,
    bodySha256: emptySha,
  },
  {
    route: '/hello',
    requestNonce: nonceB,
    connectionId: null,
    timestamp: now + 3,
    httpStatus: 401,
    bodySha256: sha256Hex(Buffer.from('error')),
  },
];
const canonicalResponse = responseInputs.map((input) => {
  const text = core.wpCanonicalResponse(input);
  return { input, text, signer: 'site', signature: site.sign(text) };
});

const pairInput = {
  pairingId,
  desktopPublicKey: desktop.publicKey,
  deviceName: 'Laptop café ✓',
  timestamp: now,
  nonce: nonceA,
};
const pairText = core.wpCanonicalPair(pairInput);
const pairProof = [
  {
    input: pairInput,
    secret: pairingSecret,
    text: pairText,
    proof: b64url(
      createHmac('sha256', Buffer.from(pairingSecret, 'base64url'))
        .update(pairText, 'utf8')
        .digest(),
    ),
  },
];

const signatureSample = desktop.sign('x');
const authValid = [
  { connectionId, timestamp: now, nonce: nonceA, signature: signatureSample },
  { connectionId: null, timestamp: 0, nonce: nonceB, signature: null },
].map((parsed) => ({ value: core.formatWpAuthField(parsed), parsed }));
const authInvalid = [
  '',
  'v2.-.1.AAECAwQFBgcICQoLDA0ODw.-',
  `v1.-.${now}.${nonceA}`,
  `v1.-.-1.${nonceA}.-`,
  `v1.-.${now}.short.-`,
  `v1.-.${now}.${nonceA}.notasignature`,
  `v1.bad id.${now}.${nonceA}.-`,
  `v1.-.${now}.${nonceA}.-.extra`,
  `v1.-.1234567890123.${nonceA}.-`,
];
for (const value of authInvalid)
  check(core.parseWpAuthField(value) === null, `auth ${value} parsed`);
for (const { value, parsed } of authValid) {
  check(JSON.stringify(core.parseWpAuthField(value)) === JSON.stringify(parsed), `auth ${value}`);
}

const key = {
  siteUrl: 'https://example.test',
  restUrl: 'https://example.test/wp-json/agentmate/v1',
  ajaxUrl: 'https://example.test/wp-admin/admin-ajax.php',
  pairingId,
  pairingSecret,
  sitePublicKey: site.publicKey,
  scope: 'write',
  expiresAt: now + 900,
};
const keyText = core.formatWpConnectionKey(key);
const labelled = { ...key, scope: 'read', label: 'Staging' };
const labelledText = core.formatWpConnectionKey(labelled);
const encodeKey = (json) => `amwp1.${b64url(Buffer.from(JSON.stringify(json), 'utf8'))}`;
const keyJson = {
  v: 1,
  u: key.siteUrl,
  r: key.restUrl,
  a: key.ajaxUrl,
  i: pairingId,
  s: pairingSecret,
  k: site.publicKey,
  c: 'write',
  x: now + 900,
};
const connectionKey = {
  now,
  valid: [
    { text: keyText, key },
    { text: labelledText, key: labelled },
    { text: `  ${keyText.slice(0, 20)}\n  ${keyText.slice(20)}\n`, key },
  ],
  invalid: [
    { text: 'hello', error: 'format' },
    { text: `amwp2.${keyText.slice(6)}`, error: 'version' },
    { text: `amwp1.${b64url(Buffer.from('not json'))}`, error: 'format' },
    { text: `amwp1.${keyText.slice(6)}=`, error: 'format' },
    { text: encodeKey({ ...keyJson, v: 2 }), error: 'version' },
    { text: encodeKey({ ...keyJson, s: b64url(Buffer.alloc(31)) }), error: 'fields' },
    { text: encodeKey({ ...keyJson, c: 'admin' }), error: 'fields' },
    { text: encodeKey({ ...keyJson, i: undefined }), error: 'fields' },
    { text: encodeKey({ ...keyJson, r: 'ftp://example.test/' }), error: 'url' },
    { text: encodeKey({ ...keyJson, u: 'https://user:pass@example.test' }), error: 'url' },
    { text: encodeKey({ ...keyJson, x: now }), error: 'expired' },
  ],
};
for (const { text, key: expected } of connectionKey.valid) {
  const parsed = core.parseWpConnectionKey(text, now);
  check(parsed.ok && JSON.stringify(parsed.key) === JSON.stringify(expected), `key ${text}`);
}
for (const { text, error } of connectionKey.invalid) {
  const parsed = core.parseWpConnectionKey(text, now);
  check(
    !parsed.ok && parsed.error === error,
    `key ${text} should be ${error}, got ${JSON.stringify(parsed)}`,
  );
}

const long = `${`${'a'.repeat(99)}/`.repeat(4)}bbbbb`;
const paths = [
  ['style.css', null],
  ['inc/setup.php', null],
  ['assets/js/app.min.js', null],
  ['a b/c d.php', null],
  ['ünïcode/файл.php', null],
  ['.htaccess', null],
  ['console.php', null],
  ['con-tact.php', null],
  ['COM10.txt', null],
  ['x/.well-known/a', null],
  ['', 'empty'],
  [long, 'tooLong'],
  ['a\u0000b', 'controlChar'],
  ['a\nb.php', 'controlChar'],
  ['a\u007fb', 'controlChar'],
  ['a\\..\\b.php', 'backslash'],
  ['/etc/passwd', 'absolute'],
  ['C:/x.php', 'driveLetter'],
  ['c:x', 'driveLetter'],
  ['file.php::$DATA', 'colon'],
  ['ab:c', 'colon'],
  ['a//b', 'emptySegment'],
  ['a/', 'emptySegment'],
  ['../wp-config.php', 'traversal'],
  ['a/../../b', 'traversal'],
  ['./a', 'traversal'],
  ['../.claude/x', 'traversal'],
  ['x'.repeat(201), 'segmentTooLong'],
  ['a./b', 'trailingDotOrSpace'],
  ['name ', 'trailingDotOrSpace'],
  ['CON', 'reservedName'],
  ['con.php', 'reservedName'],
  ['x/aux.txt', 'reservedName'],
  ['LPT1', 'reservedName'],
  ['nul.tar.gz', 'reservedName'],
  ['.claude/settings.json', 'hardDenied'],
  ['.CLAUDE/x', 'hardDenied'],
  ['sub/.git/HEAD', 'hardDenied'],
  ['AGENTS.md', 'hardDenied'],
  ['docs/claude.md', 'hardDenied'],
  ['.env', 'hardDenied'],
  ['.env.local', 'hardDenied'],
  ['.envrc', 'hardDenied'],
  ['.npmrc', 'hardDenied'],
  ['vendor/composer/auth.json', 'hardDenied'],
  ['.netrc', 'hardDenied'],
  ['.git-credentials', 'hardDenied'],
  ['.aider.conf.yml', 'hardDenied'],
  ['keys/server.pem', 'hardDenied'],
  ['id_rsa', 'hardDenied'],
  ['id_ed25519.pub', 'hardDenied'],
  ['.user.ini', 'hardDenied'],
  ['php.ini', 'hardDenied'],
  ['.DS_Store', 'hardDenied'],
  ['.agentmate/hooks/a.sh', 'hardDenied'],
  ['.claude-plugin/plugin.json', 'hardDenied'],
  ['inc/.CLAUDE.local/x.md', 'hardDenied'],
  ['.agentmate-cache/a.json', 'hardDenied'],
  ['build/.AgentMate.old/a', 'hardDenied'],
  ['.claudia/x', null],
  ['claude-notes/a.txt', null],
  ['.mcp.json', 'hardDenied'],
  ['x/.cursor/rules/r.mdc', 'hardDenied'],
].map(([path, reason]) => (reason === null ? { path, ok: true } : { path, ok: false, reason }));
for (const vector of paths) {
  const result = core.validateWpItemPath(vector.path);
  check(
    result.ok === vector.ok && (vector.ok || result.reason === vector.reason),
    `path ${JSON.stringify(vector.path)} expected ${vector.reason ?? 'ok'}, got ${JSON.stringify(result)}`,
  );
}

const slugs = [
  ['twentytwentyfive', true, false],
  ['my-plugin', true, false],
  ['Akismet_2', true, false],
  ['a', true, false],
  ['hello.php', true, true],
  ['loader.PHP', true, true],
  ['', false, false],
  ['-x', false, false],
  ['.hidden', false, false],
  ['a/b', false, false],
  ['..', false, false],
  ['con', false, false],
  ['x'.repeat(101), false, false],
  ['a b', false, false],
  ['.git', false, false],
  ['AGENTS.md', false, false],
  ['foo.', false, false],
].map(([slug, valid, fileItem]) => ({ slug, valid, fileItem }));
for (const vector of slugs) {
  check(core.isValidWpSlug(vector.slug) === vector.valid, `slug ${vector.slug}`);
  check(core.isWpFileItemSlug(vector.slug) === vector.fileItem, `file slug ${vector.slug}`);
}

const frameInputs = [
  { route: '/hello', body: {}, blobs: [] },
  {
    route: '/files/read',
    body: {
      item: { kind: 'theme', slug: 't' },
      files: [{ path: 'style.css' }, { path: 'a/b.php' }],
    },
    blobs: [Buffer.from('hello'), Buffer.alloc(0)],
  },
];
const frames = frameInputs.map(({ route, body, blobs }) => ({
  route,
  body,
  blobsHex: blobs.map(hex),
  frameHex: hex(core.encodeWpFrame({ route, body, blobs })),
}));
const goodFrame = Buffer.from(frames[1].frameHex, 'hex');
const headerLength = goodFrame.readUInt32BE(6);
const withHeader = (json) => {
  const header = Buffer.from(json, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([Buffer.from('AMWB1\n'), length, header]);
};
const invalidFrames = [
  { why: 'wrong magic', hex: hex(Buffer.concat([Buffer.from('AMWB2\n'), goodFrame.subarray(6)])) },
  { why: 'truncated length', hex: hex(goodFrame.subarray(0, 8)) },
  {
    why: 'header longer than the frame',
    hex: hex(
      Buffer.concat([
        goodFrame.subarray(0, 6),
        Buffer.from([0, 0, 255, 255]),
        goodFrame.subarray(10),
      ]),
    ),
  },
  { why: 'byte after the last blob', hex: hex(Buffer.concat([goodFrame, Buffer.from([0])])) },
  { why: 'blob longer than the frame', hex: hex(goodFrame.subarray(0, goodFrame.length - 1)) },
  { why: 'unknown route', hex: hex(withHeader('{"r":"/nope","b":{},"l":[]}')) },
  { why: 'negative blob length', hex: hex(withHeader('{"r":"/hello","b":{},"l":[-1]}')) },
  { why: 'fractional blob length', hex: hex(withHeader('{"r":"/hello","b":{},"l":[0.5]}')) },
  { why: 'no body', hex: hex(withHeader('{"r":"/hello","l":[]}')) },
  { why: 'header not JSON', hex: hex(withHeader('{"r":')) },
  { why: 'header is an array', hex: hex(withHeader('[]')) },
];
check(headerLength > 0, 'frame header length');
for (const { why, hex: bytes } of invalidFrames) {
  check(core.decodeWpFrame(Buffer.from(bytes, 'hex')) === null, `frame (${why}) decoded`);
}

const plain = goodFrame;
const gzipped = gzipSync(plain);
const gzip = { plainHex: hex(plain), gzipHex: hex(gzipped), gzipSha256: sha256Hex(gzipped) };

const multipartAuth = core.formatWpAuthField({
  connectionId,
  timestamp: now,
  nonce: nonceA,
  signature: desktop.sign(
    core.wpCanonicalRequest({
      route: '/files/read',
      timestamp: now,
      nonce: nonceA,
      connectionId,
      bodySha256: gzip.gzipSha256,
    }),
  ),
});
const boundary = 'AgentMateBoundary0123456789abcdef';
const multipartResult = core.encodeWpMultipart(multipartAuth, gzipped, boundary);
const multipart = {
  auth: multipartAuth,
  boundary,
  gzipHex: gzip.gzipHex,
  contentType: multipartResult.contentType,
  bodyHex: hex(multipartResult.body),
};

const responseFrame = core.encodeWpFrame({
  route: '/hello',
  body: { ok: true, data: { protocol: 1 } },
  blobs: [],
});
const responsePayload = gzipSync(responseFrame);
const responseInput = {
  route: '/hello',
  requestNonce: nonceA,
  connectionId: null,
  timestamp: now,
  httpStatus: 200,
  bodySha256: sha256Hex(responsePayload),
};
const responseMeta = {
  ts: now,
  status: 200,
  sig: site.sign(core.wpCanonicalResponse(responseInput)),
};
const response = {
  canonicalInput: responseInput,
  meta: responseMeta,
  frameHex: hex(responseFrame),
  payloadHex: hex(responsePayload),
  envelopeHex: hex(core.encodeWpResponse(responseMeta, responsePayload)),
};

const vectors = {
  description:
    'Shared test vectors for the AgentMate Connector protocol v1. Generated by scripts/wordpress-vectors.mjs; do not edit by hand. Frames only need to decode the same on both sides: PHP json_encode escapes differently, so its own frames are not expected to match these bytes.',
  version: 1,
  keys: {
    site: { seedHex: hex(siteSeed), publicKey: site.publicKey },
    desktop: { seedHex: hex(desktopSeed), publicKey: desktop.publicKey },
  },
  ed25519: ed25519Vectors,
  canonicalRequest,
  canonicalResponse,
  pairProof,
  authField: { valid: authValid, invalid: authInvalid },
  connectionKey,
  paths,
  slugs,
  frames,
  invalidFrames,
  gzip,
  multipart,
  response,
};

const out = join(root, 'packages/core/src/deploy/wordpress/vectors/protocol-v1.json');
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`, 'utf8');
console.log(`Wrote ${out}`);
