/**
 * The connector on a multisite network in Docker: network activation only, the Network Admin page,
 * tables on the base prefix, items across the network, and one pair plus deploy.
 * Run with: node scripts/wordpress-connector.mjs smoke (after the single-site checks).
 *
 * RUNOVA_WPC_MS_PORT picks the port (18991); RUNOVA_WPC_KEEP=1 leaves the site running.
 */
import { forms, login } from './admin.mjs';
import { putOp, SiteClient } from './client.mjs';
import { startWordPressFixture } from './fixture.mjs';
import { request } from './http.mjs';
import { connectorRelease, nextVersion, sendConnectorUpdate, sourceVersion } from './release.mjs';

const port = Number(process.env.RUNOVA_WPC_MS_PORT || 18991);
let failures = 0;

/** This file is a command-line runner; its output is the report. */
const say = (line) => process.stdout.write(`${line}\n`);

function check(condition, label, detail) {
  if (condition) {
    say(`  ok    ${label}`);
  } else {
    failures++;
    say(
      `  FAIL  ${label}${detail === undefined ? '' : `\n        ${JSON.stringify(detail).slice(0, 600)}`}`,
    );
  }
}

const site = await startWordPressFixture({ port, multisite: true });
say(`WordPress network fixture on ${site.url}`);
try {
  say('Network activation');
  const networkActive = () =>
    site.wp(['plugin', 'list', '--status=active-network', '--field=name']).split('\n');
  check(networkActive().includes('runova-connector'), 'network-activated');
  site.wp(['site', 'create', '--slug=second', '--title=Second site']);
  const second = `${site.url}/second/`;
  site.wp(['plugin', 'deactivate', 'runova-connector', '--network']);
  const attempt = site.wp(['plugin', 'activate', 'runova-connector', `--url=${second}`], {
    allowFail: true,
  });
  const siteActive = site.wp([
    'option',
    'get',
    'active_plugins',
    '--format=json',
    `--url=${second}`,
  ]);
  check(!siteActive.includes('runova-connector'), 'it never becomes active for one site only', {
    attempt,
    siteActive,
  });
  site.wp(['plugin', 'activate', 'runova-connector', '--network'], { allowFail: true });
  check(networkActive().includes('runova-connector'), 'network-activated again');

  say('Tables and guard');
  const tables = site
    .wp(['db', 'query', "SHOW TABLES LIKE '%runova%'", '--skip-column-names'])
    .split('\n');
  check(
    tables.length === 7 && tables.every((table) => table.trim().startsWith('wp_runova_')),
    'seven tables, all on the base prefix (none per site)',
    tables,
  );
  check(
    site
      .exec(
        'test -e /var/www/html/wp-content/mu-plugins/00-runova-connector-guard.php && echo there || echo gone',
      )
      .trim() === 'there',
    'the guard is installed',
  );

  say('Network Admin page');
  const superAdmin = await login(site.url, 'admin', 'admin');
  const networkPage = await superAdmin.get(
    '/wp-admin/network/settings.php?page=runova-connector&tab=status',
  );
  check(
    networkPage.status === 200 && networkPage.text.includes('nav-tab-active'),
    'super admins get it under Network Admin > Settings',
  );
  check(
    (await superAdmin.get('/wp-admin/tools.php?page=runova-connector')).status === 403,
    'there is no per-site copy of the page',
  );
  site.wp([
    'user',
    'create',
    'siteadmin',
    'siteadmin@example.test',
    '--role=administrator',
    '--user_pass=siteadmin',
    `--url=${second}`,
  ]);
  const siteAdmin = await login(site.url, 'siteadmin', 'siteadmin');
  check(
    (await siteAdmin.get('/wp-admin/network/settings.php?page=runova-connector')).status === 403,
    'a site administrator without manage_network_options cannot open it',
  );
  const plugins = await siteAdmin.get('/second/wp-admin/plugins.php');
  check(
    !plugins.text.includes('runova-connector/runova-connector.php'),
    'site administrators are not offered the plugin',
  );
  const networkPath = '/wp-admin/network/settings.php?page=runova-connector';
  const keysTab = await superAdmin.get(`${networkPath}&tab=keys`);
  const createForm = forms(keysTab.text).find(
    (form) => form.runova_connector_action === 'create_key',
  );
  check(
    (await superAdmin.post(networkPath, { ...createForm, _wpnonce: '' })).status === 403,
    'a Network Admin form without its nonce: 403',
  );
  const made = await superAdmin.post(networkPath, { ...createForm, scope: 'write', expires: '0' });
  const networkKey = made.text.match(/amwp1\.[A-Za-z0-9_-]+/)?.[0];
  check(made.status === 200 && networkKey !== undefined, 'a write key from the Network Admin page');
  const fromNetworkAdmin = new SiteClient(networkKey);
  check(
    (await fromNetworkAdmin.pair('From Network Admin')).scope === 'write',
    'that key pairs with write access',
  );

  say('Pair, list and deploy');
  const client = new SiteClient(site.keyFor('write', { label: 'Network smoke' }));
  const hello = await client.call('/hello', {}, { unsigned: true });
  check(hello.verified && hello.data.multisite === true, '/hello says multisite');
  await client.pair('Network smoke');
  const info = (await client.call('/site/info')).data;
  check(
    info.multisite === true && info.homeUrl === site.url,
    'site info is the main site',
    info.homeUrl,
  );
  const items = (await client.call('/items/list')).data.items;
  const connector = items.find(
    (item) => item.kind === 'plugin' && item.slug === 'runova-connector',
  );
  check(
    connector?.networkActive === true && connector.protected === true,
    'the connector is network-active and protected',
    connector,
  );
  check(
    items.filter((item) => item.kind === 'theme').length >= 2,
    'every installed theme is listed',
  );
  const theme = { kind: 'theme', slug: info.activeTheme.stylesheet };
  const op = putOp(theme, 'runova-network/added.txt', 'network deploy', null);
  const begin = await client.call('/deploy/begin', {
    label: 'Network smoke',
    items: [theme],
    ops: [
      { op: op.op, item: op.item, path: op.path, sha256: op.sha256, size: op.size, expected: null },
    ],
  });
  const deployId = begin.data?.deployId;
  await client.call(
    '/deploy/upload',
    { deployId, chunks: [{ op: 0, offset: 0, final: true }] },
    { blobs: [op.content] },
  );
  const commit = await client.call('/deploy/commit', { deployId });
  check(commit.ok && commit.data.state === 'applied', 'commit applies', commit);
  const verify = await client.call('/deploy/verify', { deployId });
  check(
    verify.ok && verify.data.state === 'applied' && verify.data.healthy === true,
    'health checks pass',
    verify.data,
  );
  const finalize = await client.call('/deploy/finalize', { deployId });
  check(finalize.ok && finalize.data.state === 'done', 'finalize');
  check(
    site.exec(`cat /var/www/html/wp-content/themes/${theme.slug}/runova-network/added.txt`) ===
      'network deploy',
    'the file is on the network',
  );

  say('Connector update on the network');
  {
    const current = (await client.call('/site/info')).data.pluginVersion;
    const next = nextVersion(current);
    const update = await sendConnectorUpdate(client, connectorRelease(sourceVersion(), next), next);
    check(
      update.verified && update.ok && update.data.state === 'updated',
      'the update goes through',
      update.data ?? update,
    );
    const after = await client.call('/site/info');
    check(after.ok && after.data.pluginVersion === next, 'the new version answers', after.data);
    check(networkActive().includes('runova-connector'), 'it is still network-active');
    check(
      !/\.runova-connector/.test(site.exec('ls -A /var/www/html/wp-content/plugins')),
      'no staging folder is left beside the plugin',
    );
    for (const url of [site.url, second]) {
      const home = await request(`${url}?runova_smoke=${Date.now()}`, { redirect: 'manual' });
      check(home.status === 200, `${url} still answers`, home.status);
    }
  }

  say('Uninstall from the network');
  {
    const content = '/var/www/html/wp-content';
    const fingerprint = () =>
      site.exec(
        `cd ${content} && find themes plugins mu-plugins -type f -not -path 'plugins/runova-connector/*' -not -name '00-runova-connector-guard.php' -exec sha256sum {} + | sort`,
      );
    const before = fingerprint();
    const dataDir = site.wp(['network', 'meta', 'get', '1', 'runova_connector_data_dir']);
    check(
      /^runova-connector-[0-9a-f]{12}$/.test(dataDir),
      'the data folder name is a network option',
      dataDir,
    );

    // A deploy still waiting for confirmation when the plugin is switched off.
    const pending = putOp(theme, 'runova-network/pending.php', '<?php // pending', null);
    const open = await client.call('/deploy/begin', {
      label: 'Pending at deactivation',
      items: [theme],
      ops: [
        {
          op: 'put',
          item: theme,
          path: pending.path,
          sha256: pending.sha256,
          size: pending.size,
          expected: null,
        },
      ],
    });
    const pendingId = open.data?.deployId;
    await client.call(
      '/deploy/upload',
      { deployId: pendingId, chunks: [{ op: 0, offset: 0, final: true }] },
      { blobs: [pending.content] },
    );
    const applied = await client.call('/deploy/commit', { deployId: pendingId });
    check(applied.ok && applied.data.state === 'applied', 'a deploy is pending', applied);

    site.wp(['plugin', 'deactivate', 'runova-connector', '--network']);
    const state = site.wp([
      'db',
      'query',
      `SELECT CONCAT(state, ' ', IFNULL(reason, '')) FROM wp_runova_deploys WHERE id = '${pendingId}'`,
      '--skip-column-names',
    ]);
    check(
      state.trim() === 'rolledBack interrupted',
      'network deactivation rolls the pending deploy back first',
      state,
    );
    check(
      site
        .exec(
          `test -e ${content}/themes/${theme.slug}/runova-network/pending.php && echo there || echo gone`,
        )
        .trim() === 'gone',
      'its file is gone again',
    );
    check(
      site
        .exec(
          `test -e ${content}/mu-plugins/00-runova-connector-guard.php && echo there || echo gone`,
        )
        .trim() === 'gone',
      'deactivation removes the guard',
    );

    // `wp plugin delete` only removes files (WP-CLI never runs uninstall.php for it); `uninstall`
    // is what wp-admin's Delete does: uninstall.php, then the files.
    site.wp(['plugin', 'uninstall', 'runova-connector']);
    // The tables kept the names the plugin gave them before the rename.
    const showTables = "SHOW TABLES LIKE '%runova%'";
    const tables = site.wp(['db', 'query', showTables, '--skip-column-names']);
    check(tables === '', 'all seven tables are dropped', tables);
    const networkOptions = site.wp([
      'db',
      'query',
      "SELECT meta_key FROM wp_sitemeta WHERE meta_key LIKE '%runova%'",
      '--skip-column-names',
    ]);
    check(networkOptions === '', 'no network options are left', networkOptions);
    for (const blog of site.wp(['site', 'list', '--field=blog_id']).split('\n')) {
      const table = blog.trim() === '1' ? 'wp_options' : `wp_${blog.trim()}_options`;
      const left = site.wp([
        'db',
        'query',
        `SELECT option_name FROM ${table} WHERE option_name LIKE '%runova%'`,
        '--skip-column-names',
      ]);
      check(left === '', `no options are left on site ${blog.trim()}`, left);
    }
    check(
      site.exec(`test -e ${content}/${dataDir} && echo there || echo gone`).trim() === 'gone',
      'the data folder is gone',
    );
    check(
      site.exec(`test -e ${content}/plugins/runova-connector && echo there || echo gone`).trim() ===
        'gone',
      'the plugin folder is gone',
    );
    check(fingerprint() === before, 'not one theme, plugin or mu-plugin file changed');
  }
} finally {
  if (process.env.RUNOVA_WPC_KEEP === '1') {
    say(`Left running: ${site.url}`);
  } else {
    site.stop();
  }
}

if (failures > 0) {
  say(`\n${failures} multisite check(s) failed.`);
  process.exit(1);
}
say('\nAll multisite checks passed.');
