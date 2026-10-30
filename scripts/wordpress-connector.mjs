#!/usr/bin/env node
/**
 * Builds and checks the Runova Connector WordPress plugin.
 *
 *   node scripts/wordpress-connector.mjs test [--php 7.4,8.3]   Composer install, then PHPUnit
 *   node scripts/wordpress-connector.mjs lint                   php -l on PHP 7.4, 8.0, 8.3, 8.4
 *   node scripts/wordpress-connector.mjs compat                 PHPCompatibilityWP 7.4- and the
 *                                                               WordPress security and SQL sniffs
 *   node scripts/wordpress-connector.mjs build                  dist/runova-connector.zip
 *   node scripts/wordpress-connector.mjs smoke                  the zip on a real WordPress in Docker
 *                                                               (tests/smoke/smoke.mjs)
 *
 * test, lint and compat run in Docker, since PHP is not a local requirement for working on
 * Runova. Containers are named runova-wpc-* and removed when they exit; Composer's download
 * cache lives in the runova-wpc-composer-cache volume.
 *
 * build needs plain Node only (no Docker, no node_modules), because release builds run on macOS
 * and Windows. It writes a deterministic zip: fixed entry order, fixed timestamps, text files with
 * LF line endings whatever the checkout did, and only the files the plugin ships.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = '/repo/apps/wordpress-connector';
const pluginSource = join(repoRoot, 'apps', 'wordpress-connector');
const LINT_VERSIONS = ['7.4', '8.0', '8.3', '8.4'];

function fail(message, code = 1) {
  console.error(`wordpress-connector: ${message}`);
  process.exit(code);
}

function dockerReady() {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Os}}'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    fail('Docker is not running. Start Docker and try again.');
  }
  if (result.stdout.trim() !== 'linux') fail('Docker must be running Linux containers.');
}

/** Runs one throwaway container with the repository mounted at /repo. */
function docker(image, name, command, { capture = false } = {}) {
  const args = [
    'run',
    '--rm',
    '--name',
    `runova-wpc-${name}-${process.pid}`,
    '--mount',
    `type=bind,source=${repoRoot},target=/repo`,
    '--workdir',
    pluginDir,
  ];
  if (typeof process.getuid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }
  args.push(...(image.startsWith('composer') ? composerArgs() : []), image, ...command);
  const result = spawnSync('docker', args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) fail(`Could not run docker: ${result.error.message}`);
  return result;
}

function composerArgs() {
  return [
    '--mount',
    'type=volume,source=runova-wpc-composer-cache,target=/tmp/composer-cache',
    '--env',
    'COMPOSER_CACHE_DIR=/tmp/composer-cache',
    '--env',
    'COMPOSER_HOME=/tmp/composer-home',
    // Fewer parallel downloads ride out slow links to GitHub better.
    '--env',
    'COMPOSER_MAX_PARALLEL_HTTP=4',
  ];
}

function composerInstall() {
  // Downloads from GitHub time out now and then; the cache keeps what got through, so retry.
  let status = 1;
  for (let attempt = 1; attempt <= 3 && status !== 0; attempt++) {
    const result = docker('composer:2', 'composer', [
      'install',
      '--no-interaction',
      '--no-progress',
      '--prefer-dist',
    ]);
    status = result.status ?? 1;
  }
  if (status !== 0) fail('composer install failed.', status);
}

function ensureVendor() {
  if (!existsSync(join(repoRoot, 'apps', 'wordpress-connector', 'vendor', 'autoload.php'))) {
    composerInstall();
  }
}

function test(args) {
  const flag = args.indexOf('--php');
  const versions = flag >= 0 && args[flag + 1] ? args[flag + 1].split(',') : ['8.3'];
  composerInstall();
  for (const version of versions) {
    console.log(`\nPHPUnit on PHP ${version}`);
    const result = docker(`php:${version}-cli`, `phpunit-${version.replace('.', '')}`, [
      'php',
      '-d',
      'memory_limit=512M',
      'vendor/bin/phpunit',
    ]);
    if (result.status !== 0) fail(`PHPUnit failed on PHP ${version}.`, result.status ?? 1);
  }
}

function lint() {
  // Every PHP file of the plugin and its tests; vendor and build output are not ours.
  const script = [
    'count=0; failed=0',
    "for file in $(find . -name '*.php' -not -path './vendor/*' -not -path './dist/*' | sort); do",
    '  count=$((count+1))',
    '  out=$(php -l "$file" 2>&1) || { failed=$((failed+1)); echo "$out"; }',
    'done',
    'echo "$count files, $failed with errors"',
    '[ "$failed" -eq 0 ]',
  ].join('\n');
  let broken = false;
  for (const version of LINT_VERSIONS) {
    const result = docker(
      `php:${version}-cli`,
      `lint-${version.replace('.', '')}`,
      ['sh', '-c', script],
      { capture: true },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    console.log(`PHP ${version}: ${output}`);
    if (result.status !== 0) broken = true;
  }
  if (broken) fail('php -l found errors.');
}

function compat() {
  ensureVendor();
  const result = docker('php:8.3-cli', 'compat', [
    'php',
    '-d',
    'memory_limit=1G',
    'vendor/bin/phpcs',
    '--standard=phpcs.xml.dist',
    '--report=full',
    '--report-width=120',
  ]);
  if (result.status !== 0) fail('PHPCompatibility or the WordPress sniffs found problems.');
  console.log(
    'PHPCompatibilityWP (7.4-) and WordPress.Security / WordPress.DB.PreparedSQL: clean.',
  );
}

/** What goes in the zip, from the plugin folder. Tests, Composer files, vendor and notes stay out. */
const SHIPPED = [
  'runova-connector.php',
  'uninstall.php',
  'readme.txt',
  'rescue.php',
  'guard',
  'src',
];
const TEXT = /\.(php|txt|md|css|js|json|xml|html)$/i;
const ZIP_ROOT = 'runova-connector/';

/** The version in protocol.ts, the plugin header, the PHP constant and readme.txt must agree. */
function checkVersion() {
  const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
  const pick = (text, pattern, what) => {
    const match = text.match(pattern);
    if (!match) fail(`Could not find ${what}.`);
    return match[1];
  };
  const expected = pick(
    read('packages/core/src/deploy/wordpress/protocol.ts'),
    /WP_CONNECTOR_VERSION\s*=\s*'([^']+)'/,
    'WP_CONNECTOR_VERSION in protocol.ts',
  );
  const main = read('apps/wordpress-connector/runova-connector.php');
  const found = {
    'plugin header': pick(main, /^ \* Version:\s+(\S+)\s*$/m, 'the Version header'),
    RUNOVA_CONNECTOR_VERSION: pick(
      main,
      /define\('RUNOVA_CONNECTOR_VERSION',\s*'([^']+)'\)/,
      'RUNOVA_CONNECTOR_VERSION',
    ),
    'readme.txt stable tag': pick(
      read('apps/wordpress-connector/readme.txt'),
      /^Stable tag:\s*(\S+)\s*$/m,
      'the readme stable tag',
    ),
    'guard header': pick(
      read('apps/wordpress-connector/guard/00-runova-connector-guard.php'),
      /^ \* Version:\s+(\S+)\s*$/m,
      'the guard Version header',
    ),
  };
  for (const [where, version] of Object.entries(found)) {
    if (version !== expected) {
      fail(`The ${where} says ${version}, but WP_CONNECTOR_VERSION in protocol.ts is ${expected}.`);
    }
  }
  return expected;
}

/** Every shipped file and folder, `/`-separated, in byte order. Symlinks are refused. */
function collect() {
  const entries = [];
  const walk = (relative) => {
    const absolute = join(pluginSource, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) fail(`${relative} is a symlink; the zip never holds one.`);
    if (stat.isDirectory()) {
      entries.push({ path: `${relative}/`, dir: true });
      for (const name of readdirSync(absolute)) walk(`${relative}/${name}`);
    } else if (stat.isFile()) {
      entries.push({ path: relative, dir: false, absolute });
    }
  };
  for (const name of SHIPPED) {
    if (existsSync(join(pluginSource, name))) walk(name);
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip with UTF-8 names, deflate for files, and every timestamp at 1980-01-01 00:00. */
function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(ZIP_ROOT + entry.path, 'utf8');
    let data = Buffer.alloc(0);
    if (!entry.dir) {
      data = readFileSync(entry.absolute);
      if (TEXT.test(entry.path)) data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'));
    }
    const method = entry.dir ? 0 : 8;
    const packed = entry.dir ? data : deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Unix modes: folders 0755 (plus the DOS folder bit), files 0644.
    central.writeUInt32LE(entry.dir ? ((0o040755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function writeZip(entries, version) {
  const files = entries.filter((entry) => !entry.dir).length;
  // The top-level folder first, so WordPress unpacks into wp-content/plugins/runova-connector.
  const bytes = zip([{ path: '', dir: true }, ...entries]);
  const out = join(pluginSource, 'dist', 'runova-connector.zip');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  console.log(`Built ${out}`);
  console.log(`version ${version}, ${files} files, ${bytes.length} bytes, sha256 ${sha}`);
}

function build() {
  const version = checkVersion();
  const entries = collect();
  if (!entries.some((entry) => entry.path === 'runova-connector.php')) {
    fail('The main plugin file is missing.');
  }
  writeZip(entries, version);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'test':
    dockerReady();
    test(rest);
    break;
  case 'lint':
    dockerReady();
    lint();
    break;
  case 'compat':
    dockerReady();
    compat();
    break;
  case 'build':
    build();
    break;
  case 'smoke': {
    dockerReady();
    build();
    // --only=single or --only=multisite runs one suite; both run by default.
    const only = rest.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
    const suites = { single: 'smoke.mjs', multisite: 'multisite.mjs' };
    for (const [suite, file] of Object.entries(suites)) {
      if (only && only !== suite) continue;
      const result = spawnSync(process.execPath, [join(pluginSource, 'tests', 'smoke', file)], {
        stdio: 'inherit',
      });
      if (result.status !== 0) fail(`The ${suite} smoke checks failed.`, result.status ?? 1);
    }
    break;
  }
  default:
    fail(
      'Usage: node scripts/wordpress-connector.mjs test [--php 7.4,8.3] | lint | compat | smoke | build',
      2,
    );
}
