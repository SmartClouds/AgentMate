/**
 * A throwaway WordPress site in Docker with Runova Connector installed from the built zip.
 * Reusable from other tests:
 *
 *   import { startWordPressFixture } from '.../apps/wordpress-connector/tests/smoke/fixture.mjs';
 *   const site = await startWordPressFixture({ port: 18990 });  // { multisite: true } for a network
 *   const key = site.keyFor('write');          // a fresh connection key
 *   site.wp(['plugin', 'activate', 'hello']);  // WP-CLI (returns stdout; { allowFail: true } to not throw)
 *   site.exec('cat /var/www/html/wp-content/themes/x/style.css');
 *   site.writeFile('/var/www/html/wp-content/mu-plugins/x.php', '<?php ...');
 *   await site.config(['set', 'WP_DEBUG', 'true', '--raw']);  // waits out Apache's opcache
 *   site.serveDownloads({ 'https://github.com/...zip': '/runova-dist/x.zip' });  // see below
 *   site.stop();
 *
 * `slug` and `cli` name the plugin folder and the WP-CLI command when the zip is not the current
 * plugin (an older release under its old names, say).
 *
 * MariaDB, WordPress (Apache on the same port as the host mapping, so loopback works) and one-off
 * WP-CLI containers share a network. WP_DEBUG logs to wp-content/debug.log, never to the page. The
 * admin user is admin / admin. Everything is named runova-wpc-<port>-* and removed by stop(),
 * volumes included. Plain Node only: no packages, no build of the rest of the repo.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(pluginRoot, '..', '..');
const DB_ENV = [
  '-e',
  'WORDPRESS_DB_HOST=db',
  '-e',
  'WORDPRESS_DB_USER=wp',
  '-e',
  'WORDPRESS_DB_PASSWORD=wp',
  '-e',
  'WORDPRESS_DB_NAME=wp',
];

function docker(args, { allowFail = false, input } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`docker could not run: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    // Exit status and signal too: a container killed for memory says nothing on stderr.
    const how = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(
      `docker ${args.slice(0, 3).join(' ')} failed (${how}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

/** WordPress's rewrite rules for a subdirectory network. */
const MULTISITE_HTACCESS = [
  '# BEGIN WordPress Multisite',
  'RewriteEngine On',
  'RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]',
  'RewriteBase /',
  'RewriteRule ^index\\.php$ - [L]',
  'RewriteRule ^([_0-9a-zA-Z-]+/)?wp-admin$ $1wp-admin/ [R=301,L]',
  'RewriteCond %{REQUEST_FILENAME} -f [OR]',
  'RewriteCond %{REQUEST_FILENAME} -d',
  'RewriteRule ^ - [L]',
  'RewriteRule ^([_0-9a-zA-Z-]+/)?(wp-(content|admin|includes).*) $2 [L]',
  'RewriteRule ^([_0-9a-zA-Z-]+/)?(.*\\.php)$ $2 [L]',
  'RewriteRule . index.php [L]',
  '# END WordPress Multisite',
  '',
].join('\n');

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * The image's opcache.revalidate_freq: Apache may run its cached copy of a changed PHP file, such
 * as wp-config.php, for up to this long after the change.
 */
const OPCACHE_REVALIDATE_MS = 2000;

/** Builds dist/runova-connector.zip when it is not there yet. */
export function connectorZip() {
  const zip = join(pluginRoot, 'dist', 'runova-connector.zip');
  if (!existsSync(zip)) {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'wordpress-connector.mjs'), 'build'],
      {
        stdio: 'inherit',
      },
    );
    if (result.status !== 0) throw new Error('Building the connector zip failed.');
  }
  return zip;
}

/**
 * @param {{ port?: number, multisite?: boolean, image?: string, cliImage?: string, dbImage?: string, zip?: string, slug?: string, cli?: string }} [options]
 */
export async function startWordPressFixture(options = {}) {
  const port = options.port ?? 18990;
  const image = options.image ?? 'wordpress:php8.3-apache';
  const cliImage = options.cliImage ?? 'wordpress:cli-php8.3';
  const dbImage = options.dbImage ?? 'mariadb:11';
  const zip = options.zip ?? connectorZip();
  const slug = options.slug ?? 'runova-connector';
  const cli = options.cli ?? 'runova';
  const name = `runova-wpc-${port}`;
  const network = `${name}-net`;
  const url = `http://localhost:${port}`;
  const startScript = readFileSync(
    join(pluginRoot, 'tests', 'docker', 'start-apache.sh'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  const stop = () => {
    docker(['rm', '-f', '-v', `${name}-wp`, `${name}-db`], { allowFail: true });
    docker(['network', 'rm', network], { allowFail: true });
  };
  stop();

  try {
    docker(['network', 'create', network]);
    docker([
      'run',
      '-d',
      '--name',
      `${name}-db`,
      '--network',
      network,
      '--network-alias',
      'db',
      '-e',
      'MARIADB_ROOT_PASSWORD=root',
      '-e',
      'MARIADB_DATABASE=wp',
      '-e',
      'MARIADB_USER=wp',
      '-e',
      'MARIADB_PASSWORD=wp',
      dbImage,
    ]);
    docker([
      'run',
      '-d',
      '--name',
      `${name}-wp`,
      '--network',
      network,
      '-p',
      `127.0.0.1:${port}:${port}`,
      '-e',
      `RUNOVA_PORT=${port}`,
      ...DB_ENV,
      '--mount',
      `type=bind,source=${dirname(zip)},target=/runova-dist,readonly`,
      image,
      'sh',
      '-c',
      startScript,
    ]);

    const wp = (args, { allowFail = false } = {}) =>
      docker(
        [
          'run',
          '--rm',
          '--name',
          `${name}-cli-${randomBytes(4).toString('hex')}`,
          '--network',
          network,
          '--volumes-from',
          `${name}-wp`,
          '--user',
          '33:33',
          ...DB_ENV,
          cliImage,
          'wp',
          ...args,
        ],
        { allowFail },
      ).stdout.trim();
    const exec = (command, { allowFail = false } = {}) =>
      docker(['exec', `${name}-wp`, 'sh', '-c', command], { allowFail }).stdout;

    // The image copies WordPress in on first start; then the database has to come up.
    for (let attempt = 0; ; attempt++) {
      if (
        docker(['exec', `${name}-wp`, 'test', '-f', '/var/www/html/wp-config.php'], {
          allowFail: true,
        }).status === 0
      )
        break;
      if (attempt > 120) throw new Error('WordPress did not start.');
      await sleep(1000);
    }
    for (let attempt = 0; ; attempt++) {
      const install = docker(
        [
          'run',
          '--rm',
          '--name',
          `${name}-cli-install`,
          '--network',
          network,
          '--volumes-from',
          `${name}-wp`,
          '--user',
          '33:33',
          ...DB_ENV,
          cliImage,
          'wp',
          'core',
          'install',
          `--url=${url}`,
          '--title=Runova Fixture',
          '--admin_user=admin',
          '--admin_password=admin',
          '--admin_email=admin@example.test',
          '--skip-email',
        ],
        { allowFail: true },
      );
      if (install.status === 0) break;
      if (attempt > 60) throw new Error(`WordPress could not be installed: ${install.stderr}`);
      await sleep(2000);
    }
    const writeFile = (path, content) =>
      docker(['exec', '-i', '-u', '33:33', `${name}-wp`, 'sh', '-c', `cat > '${path}'`], {
        input: content,
      });

    wp(['rewrite', 'structure', '/%postname%/', '--hard']);
    // Log every notice, but never print one into a reply.
    wp(['config', 'set', 'WP_DEBUG', 'true', '--raw']);
    wp(['config', 'set', 'WP_DEBUG_LOG', 'true', '--raw']);
    wp(['config', 'set', 'WP_DEBUG_DISPLAY', 'false', '--raw']);
    const zipInContainer = `/runova-dist/${zip.split(/[\\/]/).pop()}`;
    if (options.multisite) {
      // A subdirectory network; the connector can only be network-activated.
      wp(['core', 'multisite-convert', '--title=Runova Network']);
      writeFile('/var/www/html/.htaccess', MULTISITE_HTACCESS);
      wp(['plugin', 'install', zipInContainer]);
      wp(['plugin', 'activate', slug, '--network']);
    } else {
      wp(['plugin', 'install', zipInContainer, '--activate']);
    }

    return {
      url,
      port,
      name,
      multisite: options.multisite === true,
      wp,
      exec,
      writeFile,
      /**
       * `wp config <args>`, then a wait until the web server runs the new wp-config.php. Without
       * the wait, a request in the next 2 seconds may still see the old constants.
       */
      async config(args) {
        const out = wp(['config', ...args]);
        await sleep(OPCACHE_REVALIDATE_MS + 1000);
        return out;
      },
      /** A new one-time connection key from `wp runova key create`. */
      keyFor(scope, { label, expiresIn } = {}) {
        const args = [cli, 'key', 'create', `--scope=${scope}`, '--porcelain'];
        if (label) args.push(`--label=${label}`);
        if (expiresIn) args.push(`--expires-in=${expiresIn}`);
        return wp(args);
      },
      /**
       * Answers the site's own HTTP requests for these addresses with files from the container
       * (the zip's folder is mounted at /runova-dist), through a pre_http_request mu-plugin, so
       * the plugin's "download the release itself" path runs without reaching GitHub.
       */
      serveDownloads(map) {
        const entries = Object.entries(map)
          .map(([address, path]) => `  ${JSON.stringify(address)} => ${JSON.stringify(path)},`)
          .join('\n');
        writeFile(
          '/var/www/html/wp-content/mu-plugins/zz-test-downloads.php',
          [
            '<?php',
            '// Test fixture only: release downloads come from local files.',
            "add_filter('pre_http_request', function ($pre, $args, $url) {",
            '  $map = array(',
            entries,
            '  );',
            '  if (!isset($map[$url]) || !is_file($map[$url])) {',
            '    return $pre;',
            '  }',
            "  return array('headers' => array(), 'body' => file_get_contents($map[$url]), 'response' => array('code' => 200, 'message' => 'OK'), 'cookies' => array(), 'filename' => null);",
            '}, 10, 3);',
            '',
          ].join('\n'),
        );
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
