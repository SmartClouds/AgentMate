# AgentMate Connector: working notes

Short notes for whoever works on the plugin next. The contract lives in
`packages/core/src/deploy/wordpress/` (TS is the source of truth); `tests/Unit/VectorsTest.php`
runs every shared vector.

## Running things

- `node scripts/wordpress-connector.mjs test [--php 7.4,8.3]` (Composer in `composer:2`, PHPUnit in
  `php:X-cli`), `lint` (php -l on 7.4/8.0/8.3/8.4), `compat` (PHPCompatibilityWP 7.4-, WordPress
  Security and PreparedSQL sniffs), `smoke [--only=single|multisite]` (builds the zip, then
  `tests/smoke/smoke.mjs` on a single site and `tests/smoke/multisite.mjs` on a network, in
  Docker; `AGENTMATE_WPC_PORT` (18990), `AGENTMATE_WPC_MS_PORT` (18991), `AGENTMATE_WPC_KEEP=1`).

## wp-admin and WP-CLI

- One page with tabs (Keys, Connections, Deploys, Audit log, Status): Tools on a single site,
  Network Admin > Settings on multisite. `Admin\AdminPage` is the glue, `Admin\AdminViews` prints
  (escaped where printed), `Admin\AdminActions` decides: capability, then nonce, then the work.
  Nonces are per object (`agentmate_connector_revoke_<id>`, `..._rollback_<id>`). Revoke and roll
  back redirect with `agentmate_notice=<code>`; a new key renders once in the POST reply.
- Rights: manage_options (manage_network_options on multisite) for the page and revoking; write
  keys and rollbacks also need install_plugins and install_themes (so DISALLOW_FILE_MODS blocks
  them for everyone).
- WP-CLI: `wp agentmate key create`, `connections list|revoke <id>`, `deploys list`, `status`,
  `rescue status|rollback`. `Info\StatusChecks` backs both the Status tab and `wp agentmate status`;
  its loopback probe from a WP-CLI container fails in Docker (localhost is the CLI container).
- `build` is plain Node (no Docker, no node_modules; CD runs it on macOS and Windows): checks the
  version in protocol.ts, the header, the PHP constant and readme.txt agree, then writes
  `dist/agentmate-connector.zip` from the `SHIPPED` list (own zip writer on node:zlib, sorted
  entries, 1980-01-01 timestamps, CRLF turned into LF). New top-level files go into `SHIPPED`.
  The smoke fixture installs this zip with `wp plugin install`, so the zip is tested too.
- The schema and guard check (`Activator::maybeUpgrade`) only runs in admin, WP-CLI and our own
  requests, so visitors' page views cost nothing.
- Composer resolves for PHP 7.4.33 (`config.platform`), so one vendor folder runs on 7.4 to 8.4.
- Docker Hub and GitHub downloads time out now and then; the script retries Composer three times.
- In Git Bash, prefix ad hoc `docker run` with `MSYS_NO_PATHCONV=1`.

## Shape of the code

- `Http\Dispatcher` is transport-free: `IncomingRequest` in, `OutgoingResponse` out. Entry points:
  `Http\Transport` (REST, admin-ajax), `Guard\GuardRuntime` (rescue routes before regular plugins)
  and `Guard\Rescue` (rescue.php under SHORTINIT). `Routes\Handlers` builds the route maps.
- `Env\Environment` hides every WordPress call; tests use `tests/Support/FakeEnvironment.php` over
  a temp wp-content. `WordPressEnvironment(true)` is the SHORTINIT flavour (no wp-admin includes).
- `Storage\Storage`: `WpdbStorage` and `MemoryStorage`, same semantics. Locks use `kvAdd` (delete
  expired, then `INSERT IGNORE` + row count). Deploy updates are compare-and-set on `state` and
  bump `rev`, so a matched row always counts as changed.
- `Deploy\DeployService` is the transaction; `Deploy\StateMachine::TABLE` is the state table.

## Decisions the contract does not pin

- HTTP status per error code: `Protocol::STATUS`. 413 only for a request body that is too big.
  A file over 64 MiB on read is `pathRejected` with `details.reason = tooLarge`, not `tooLarge`.
- Replies are signed over route (or `-` when the URL named no known route), the request nonce
  (`-` when am_auth did not parse) and the connection id the request named.
- `/hello`: no timestamp check, no nonce stored, body not read. Capabilities: pair, read, audit,
  revoke, deploy, rescue. `rescueUrl` is `plugins_url('rescue.php')` only when it is on the site's
  own origin, else null.
- `/pair`: bundle capped at 64 KiB before and after gunzip. Bad proof or bad signature both count
  as an attempt; 5 attempts burn the pairing. Connection label = key label, else the device name.
  Connection expiry = pairing time + `--expires-in` days.
- Nonces are stored as sha256(`connectionId\nnonce`) (or `pair\nnonce`) for 660 s.
- Rate limiter state is in kv under `rl:<sha256(ip)>`. A locked-out address still lets through a
  signed request naming a live connection (shared NAT); it is fully verified and a bad signature
  counts as another failure. Unknown, unsigned, /hello and /pair stay locked out.
- Audit: refusals that name no known connection are not written (only counted). `authFailed` and
  `rateLimited` are "noise" (column `noise`), capped at 500 on their own, so they never evict the
  2000 real events. One `rateLimited` row per address per lockout.
- Clone safety: the site key option records the raw `home` option. When host, port or path differ
  (scheme does not count), the key is renewed, every connection is revoked, unused keys are
  deleted, and the audit log says why (`Auth\SiteMove`). Checked wherever the key loads (plugin,
  activation, rescue.php).
- Admin pages hold no inline handlers or inline scripts with data in them: confirmations are
  `data-agentmate-confirm` attributes run by one fixed enqueued script (`AdminViews::SCRIPT`).
  Device names and labels pass `Text::displaySafe` before they are stored (no C0/C1 controls,
  bidi overrides or zero-width characters). Remember esc_attr does not double-encode: never put
  escaped user text inside JavaScript.
- Path policy also denies `.npmrc`, `auth.json`, `.netrc`, `.git-credentials`, after NFKC
  (`Normalizer` when ext-intl is there, else a fallback for fullwidth ASCII, the long s, one-dot
  leaders and Latin ligatures).
- Manifest cursor: `<files listed so far>.<base64url(last path)>`. The hash cache never stores or
  trusts files modified in the last 2 seconds (mtime has one-second steps).
- `/files/read`: past the response budget `length: 0`; a vanished file is
  `{offset, length: 0, size: 0, sha256: "", missing: true}`.

## Deploys

- State answers (B's fake mirrors this; "same" = ok with the current state, unchanged):
  - upload: open runs; anything else `invalidState`.
  - commit: open validates (any syntaxErrors, conflicts or refusals: ok, `state: open`, nothing
    touched), else applies; applying resumes; applied, done, rolledBack, aborted, expired: same.
  - verify: applied runs (heartbeat, then health checks; a regression rolls back, answer
    `state: rolledBack, healthy: false`); open and applying `invalidState`; others same.
  - finalize: applied becomes done; done same; everything else `invalidState` (never ok after a
    rollback; details carry state and reason).
  - rollback: open becomes aborted; applying and applied rolledBack(requested); done rolls back if
    its snapshot is kept and nothing changed since, else ok with `state: done` and `conflicts`
    (force overrides); terminal states same.
  - abort: open aborted; applying and applied rolledBack(requested); done `invalidState`; others same.
  - begin while a deploy is active: `busy` with `details.deployId`. Two calls at once: `busy`
    with `details.retryAfter` (the per-site mutex).
- Timeouts: open expires after 30 min without a call. Applying: deadline = last journal save +
  confirm window, rolledBack(interrupted) when passed. Applied: deadline = apply + confirm window,
  pushed by each verify, never past apply + 15 min, then rolledBack(notConfirmed). The confirm
  window is 180 s; `AGENTMATE_CONNECTOR_CONFIRM_SECONDS` (5..180) shortens it for tests.
- Begin and commit refuse (not forceable): path policy reasons, `symlink`, `notWritable` (folder in
  the way, unwritable item), `itemProtected`, `itemUnknown` (missing item without `create`),
  `tooLarge`. Forceable: conflicts, `deletesActivePluginMainFile`, `touchesActiveThemeCore`
  (deleting style.css or index.php of the active theme or its parent). Syntax errors never.
- Puts whose content is already staged (same sha256, including empty files) need no upload; the
  upload reply reports them at full size. Chunks: offset must equal the part's size (a repeat of
  bytes already there is ignored); a hash mismatch on `final` drops the part (`nextOffset: 0`).
- Apply: journal phases `snapshot` (copy every touched file into blobs/) then `apply` (temp file
  in the same folder, rename, unlink-then-rename fallback). Both phases repeat safely, so the
  journal is saved every 2 s and at the end of the time budget. Any write error rolls back
  (interrupted). Kept: 20 history records, snapshots of the 5 newest done deploys.
- Data dir: `blobs/<sha256>` and `parts/<deploy>-<op>`, garbage-collected after each finish.
- Guard: `guard/00-agentmate-connector-guard.php` is a template; activation (and maybeUpgrade)
  writes it into mu-plugins with the plugin folder filled in; deactivation first rolls back
  (interrupted) or aborts any pending deploy, then removes it. Its option
  `agentmate_connector_guard` always exists, autoloaded, `''` when idle (multisite: a network
  option, one small query). Pending value: `{d, t, f}` (deploy id, deadline, changed PHP files).
- rescue.php finds wp-load.php through `rescue-config.php` (written into the plugin folder on
  activation), else by walking up. It answers only the rescue routes and nothing when the plugin
  is inactive.

## Connector update

- `/connector/update` (write scope, so the dispatcher already applies `AGENTMATE_CONNECTOR_READ_ONLY`,
  `DISALLOW_FILE_MODS` and the direct filesystem check). `Update\ConnectorUpdater` is the whole
  thing; `Routes\UpdateHandlers` is the route. The request is `{version, files: [{path, size,
  sha256}]}` with one blob per file, so the plugin never needs ZipArchive and the update can't
  carry anything but plain files.
- Or the site downloads it (`updateDownload` in `/site/info` and `/hello`): the same file list
  plus `download: {url}` and no blobs. The URL must match `Protocol::UPDATE_DOWNLOAD_URL` (the
  plugin zip on an AgentMate GitHub release, tagged with the version being installed), so a key
  can't point the site at any other address. `Environment::download` fetches it with
  `wp_safe_remote_get` (redirects followed, 30 s, size capped), `Update\ZipReader` reads it in
  memory (stored or deflate, no ZipArchive, every offset bounds-checked), and every file must
  match the listed size and sha256 with no file more or less. Any of that failing is
  `updateRefused` with reason `downloadFailed` before anything is written, which tells the app to
  send the files itself. The list is checked (paths, required files) before the download.
- Order: validate everything in memory (shape, paths through `PathPolicy`, an extension allow-list,
  sizes, sha256, required files, the main file's header and constant against `version`, no
  downgrade, `Requires PHP` and `Requires at least`, PHP syntax). Then, holding the deploy mutex
  and with no deploy open (`DeployService::whileIdle`): sweep leftovers, build
  `.agentmate-connector-new-<hex>` beside the plugin (a dot folder: `get_plugins()` skips it),
  copy `rescue-config.php` across, preload every class of the running version (so the rest of the
  request never mixes old and new code), take a health baseline, swap with two renames
  (`-old-<hex>` holds the previous folder), invalidate opcache for every PHP path, health check
  again. `DeployService::health` false means the swap is undone (`rolledBack`), otherwise the old
  folder is deleted. A health check that could not run (loopback blocked) is not a failure.
- Failure leaves things as they were: a refused first rename removes the staged folder; a refused
  second rename moves the old folder back. Only when that also fails are both folders left, named
  in the error, for the site owner.
- The new code's `Activator::maybeUpgrade()` runs in the loopback `ajaxPing` (admin-ajax counts as
  admin), so the schema and the guard template are brought up to date during the health check. A
  rollback leaves a newer guard until the old code's next admin request rewrites it.
- `selfUpdate` in `/site/info` is `ConnectorUpdater::replaceable`: the connector's folder is a real
  folder (not a symlink, a valid slug) and PHP may write it and the plugins folder. Connectors
  older than this route don't send it, which is how the app knows to ask for one manual upload.
- Tests: `ConnectorUpdateTest` (fake environment, injectable rename), and the smoke script's
  "Connector update from the app" (a broken release is rolled back on real WordPress, then a
  good one lands and a deploy still works).

## Smoke fixture

`tests/smoke/fixture.mjs` exports `startWordPressFixture({ port, multisite }) -> { url, port, name,
multisite, wp(args), exec(cmd), writeFile(path, content), keyFor(scope, { label, expiresIn }),
stop() }` and `connectorZip()`. MariaDB + `wordpress:php8.3-apache` (Apache moved to the host
port by `tests/docker/start-apache.sh`, so loopback works) + one-off `wordpress:cli-php8.3`
containers, WP_DEBUG logging on, display off, admin / admin. With `multisite: true` it converts to
a subdirectory network (WordPress multisite works on a non-standard port here) and
network-activates the connector. `tests/smoke/client.mjs` is a plain-Node signed client and
`tests/smoke/admin.mjs` a cookie-jar wp-admin session.
