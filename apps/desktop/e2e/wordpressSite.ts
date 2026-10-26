import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT } from './paths';

/**
 * A throwaway WordPress site in Docker with the Runova Connector plugin, from the connector's
 * own smoke fixture (apps/wordpress-connector/tests/smoke/fixture.mjs). Its containers are named
 * runova-wpc-<port>-* and `stop()` removes them with their volumes.
 */

export interface WordPressSite {
  url: string;
  port: number;
  name: string;
  /** WP-CLI in a one-off container that shares the site's files and database. */
  wp(args: string[], options?: { allowFail?: boolean }): string;
  /** A shell command in the WordPress container, as root. */
  exec(command: string, options?: { allowFail?: boolean }): string;
  /** A new one-time connection key from `wp runova key create`. */
  keyFor(scope: 'read' | 'write'): string;
  stop(): void;
}

const FIXTURE = join(APP_ROOT, '..', 'wordpress-connector', 'tests', 'smoke', 'fixture.mjs');

export async function startWordPressSite(port: number): Promise<WordPressSite> {
  // An ES module, and Windows paths only import as file URLs.
  const { startWordPressFixture } = (await import(pathToFileURL(FIXTURE).href)) as {
    startWordPressFixture: (options: { port: number }) => Promise<WordPressSite>;
  };
  return startWordPressFixture({ port });
}

/**
 * A small classic theme, made in the container and switched on: style.css, index.php, and a
 * functions.php that loads inc/setup.php, so a fatal error in setup.php breaks every page.
 */
export function addActiveTheme(site: WordPressSite, slug: string, themeName: string): string {
  const dir = `/var/www/html/wp-content/themes/${slug}`;
  site.exec(
    [
      `mkdir -p ${dir}/inc`,
      `printf '/*\\nTheme Name: ${themeName}\\n*/\\n' > ${dir}/style.css`,
      `printf '<?php echo "home ok";\\n' > ${dir}/index.php`,
      `printf '<?php\\nrequire __DIR__ . "/inc/setup.php";\\n' > ${dir}/functions.php`,
      `printf '<?php // setup v1\\n' > ${dir}/inc/setup.php`,
      `chown -R www-data:www-data ${dir}`,
    ].join(' && '),
  );
  site.wp(['theme', 'activate', slug]);
  return dir;
}

/** A file on the site as it is now, or `__missing__` when there is none. */
export function siteFile(site: WordPressSite, path: string): string {
  return site.exec(`cat '${path}' 2>/dev/null || echo __missing__`).trim();
}

/** Whether anything (file or folder) exists at this path on the site. */
export function existsOnSite(site: WordPressSite, path: string): boolean {
  return site.exec(`test -e '${path}' && echo yes || echo no`).trim() === 'yes';
}
