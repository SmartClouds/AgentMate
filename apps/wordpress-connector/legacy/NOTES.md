# Moving sites off AgentMate Connector 1.63

The plugin was called AgentMate Connector up to 1.63. Sites in the field run that release under
the old names, and its updater only takes a package that looks like itself. This folder holds the
files that must keep the old names; a rename script skips folders called `legacy/`. Everything
else that spells an old name sits in `src/Legacy.php` or carries the marker comment `legacy-name`.

## What keeps its old name, and why

- Tables (`{base_prefix}agentmate_*`), network options (`agentmate_connector_*`), the data folder
  `wp-content/agentmate-connector-<hex>` (new installs get `runova-connector-<hex>`; both names
  are read). Renaming a table needs rights many hosts do not grant, a crash between the rename and
  the version option would let `dbDelta` make empty tables, and only a database admin sees them.
- wp-config.php switches and the client IP filter belong to site owners: `AGENTMATE_CONNECTOR_*`
  and `agentmate_connector_client_ip` work next to the `RUNOVA_` ones, forever
  (`Support\Constants`, the Runova name wins). `wp agentmate ...` is an alias of `wp runova ...`.
- The REST namespace `agentmate/v1`, the ajax action `agentmate_connector` (and its `_ping`, which
  answers `agentmate-pong`: the 1.63 updater's health check calls it right after installing the
  bridge), and the signing prefix `agentmate-wp/v1`, until 1.63 desktops are dropped. A request is
  checked against both prefixes and the reply uses the one that verified; an unsigned or failed
  request is answered with the prefix its address suggests.
- The 1.63 guard calls `\AgentMate\Connector\Autoloader` and `GuardRuntime` by their old names, and
  it can stay in mu-plugins for a while (or for good, if mu-plugins is read-only), so
  `src/Autoloader.php` aliases every old class name to the Runova class.

## The bridge package

`node scripts/wordpress-connector.mjs build` writes `dist/agentmate-connector.zip` beside
`dist/runova-connector.zip`, from the same source: root `agentmate-connector/`, main file
`legacy/agentmate-connector.php` (header exactly "AgentMate Connector", `AGENTMATE_CONNECTOR_VERSION`
first, so the 1.63 `checkMain` accepts it), the retired guard file `legacy/guard/...` (1.63 lists it
as required), and the Runova main file in `layout/runova-connector.php`, one level down so WordPress
lists one plugin. The bridge main file returns at once when `runova-connector` is active.

The app sends the bridge to any site that reports no `layout` (1.63) or `layout: bridge`, even at
the same version (1.63 takes the same version, just not an older one), asking the site to download
it from `SmartClouds/AgentMate/releases/download/v<version>/agentmate-connector.zip` first, which
GitHub redirects to the renamed repository. In the bridge layout `ConnectorUpdater` takes only the
bridge package again.

## The move (`Update\LayoutMigration`)

Only `/connector/migrate` (signed, write scope), the wp-admin notice's button and `wp runova
migrate` start it, never a page load (that would race the 1.63 updater's loopback probe). Under
`DeployService::whileIdle`: copy the running folder (it is still running) to
`.runova-connector-new-<hex>`, promote `layout/runova-connector.php`, leave the bridge-only files
out, parse the main file, rename into place; write the guard for the new folder and remove the
1.63 guard; swap the plugin entry in `active_plugins` and every network's `active_sitewide_plugins`
as plain option writes (no activation hooks: the bridge's deactivation hook would remove the
guard); health-check. A check that passed before and fails now puts back the entry, both guard
files and the new folder. The reply carries the new `restUrl`, `ajaxUrl` and `rescueUrl`.

Refused before anything changes: no `layout/` file, a plugins folder PHP cannot write, a
`runova-connector` folder that is not our own leftover (same version, inactive), a guard that
exists but cannot move because mu-plugins is read-only.

The old folder is deleted 10 minutes later (`RUNOVA_CONNECTOR_MIGRATION_GRACE_SECONDS` shortens it
for tests) by `LayoutMigration::cleanUp`, from WP-Cron or the next admin, WP-CLI or app request,
and only while the Runova copy is the active one. Never through `delete_plugins()`, which would run
its `uninstall.php`. `uninstall.php` does nothing while the other layout is on disk, and
`Activator::installSchema` skips `dbDelta` then, so an older copy cannot put back its schema.
Activating `runova-connector` beside an active 1.63 copy takes over: the old entry is removed
without its hook and its `uninstall.php` is disarmed.

## Tests

- `tests/Unit/LegacyLayoutTest.php`: the move, its rollbacks, the cleanup, bridge updates, both
  prefixes, both constant names, the class aliases, the guard swap.
- `apps/desktop/src/main/deploy/wordpress/connectorMigration.int.test.ts`
  (`RUNOVA_SYSTEM_TESTS=1`): the real 1.63.0 zip (sha-pinned, cached in the temp folder), single
  site and network: pair and deploy on 1.63, update through the 1.63 updater (the site downloads
  the bridge through a `pre_http_request` mu-plugin), a move that fails its health check, a
  read-only plugins folder, the move, both namespaces, rescue.php at its new address,
  `AGENTMATE_CONNECTOR_READ_ONLY`, a deploy afterwards, the old folder gone after the grace
  period, and deleting the old copy with its uninstall.php keeping the tables.
